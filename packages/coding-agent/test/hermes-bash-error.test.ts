import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";
import type { AgentSessionEvent } from "../src/session/agent-session";

type StreamState = { text: string; model: string; started: boolean; tools: Map<string, string> };
type ToolEnd = Extract<AgentSessionEvent, { type: "tool_execution_end" }>;

describe("hermes bash failure stays failed", () => {
	it("keeps exit 1 on the failed id when a later retry succeeds", () => {
		const state: StreamState = { text: "", model: "hermes", started: false, tools: new Map() };
		const cards = new Map<string, { status: "error" | "done"; exit?: number }>();

		const failStart = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: { tool_id: "test:first", name: "terminal", args: { command: "npm test -- tasks" } },
			},
			state,
		);
		const failEnd = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: {
					tool_id: "test:first",
					name: "shell",
					result: { output: "Expected the whitespace-only case to reject", exit_code: 1 },
				},
			},
			state,
		);
		expect(failStart[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "test:first",
			toolName: "bash",
			args: { command: "npm test -- tasks" },
		});
		const failed = failEnd[0] as ToolEnd;
		expect(failed).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "test:first",
			toolName: "bash",
			isError: true,
			result: { details: { exitCode: 1 } },
		});
		cards.set(failed.toolCallId, { status: failed.isError ? "error" : "done", exit: failed.result.details?.exitCode });

		const retryStart = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: { tool_id: "test:retry", name: "terminal", args: { command: "npm test -- tasks" } },
			},
			state,
		);
		const retryEnd = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "test:retry", result: { output: "2 tests passed", exit_code: 0 } },
			},
			state,
		);
		const retried = retryEnd[0] as ToolEnd;
		expect(retryStart[0]?.toolCallId).toBe("test:retry");
		expect(retried.toolCallId).toBe("test:retry");
		expect(retried.toolCallId).not.toBe(failed.toolCallId);
		expect(retried).toMatchObject({
			type: "tool_execution_end",
			toolName: "bash",
			isError: false,
			result: { details: { exitCode: 0 } },
		});
		cards.set(retried.toolCallId, { status: retried.isError ? "error" : "done", exit: retried.result.details?.exitCode });

		expect(cards.get("test:first")).toEqual({ status: "error", exit: 1 });
		expect(cards.get("test:retry")).toEqual({ status: "done", exit: 0 });
		expect(cards.get("test:first")?.status).not.toBe("done");
	});
});
