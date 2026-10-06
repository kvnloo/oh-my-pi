import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes event mapping", () => {
	it("keeps one tool id and reads terminal output", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-9", name: "terminal", args: { command: "echo ok" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "tool-9", result: { output: "tool-card-ok", exit_code: 0 } },
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-9",
			toolName: "bash",
			args: { command: "echo ok" },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-9",
			toolName: "bash",
			result: { content: [{ type: "text", text: "tool-card-ok" }], details: { exitCode: 0 } },
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});

	it("maps duration_s onto the same tool id as wallTimeMs", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-took", name: "terminal", args: { command: "sleep 1" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: {
					tool_id: "tool-took",
					duration_s: 1.5,
					result: { output: "ok", exit_code: 0 },
				},
			},
			state,
		);
		expect(done).toHaveLength(1);
		expect(start[0]?.toolCallId).toBe("tool-took");
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-took",
			toolName: "bash",
			isError: false,
			result: { details: { exitCode: 0, wallTimeMs: 1500 } },
		});
	});
});
