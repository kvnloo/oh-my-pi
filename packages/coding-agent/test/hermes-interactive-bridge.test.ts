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

	it("keeps two tool ids for read_file and terminal in one stream", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const startA = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "a", name: "read_file", args: { path: "README.md" } } },
			state,
		);
		const startB = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "b", name: "terminal", args: { command: "echo ok" } } },
			state,
		);
		const doneA = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "a", result: { output: "readme", exit_code: 0 } },
			},
			state,
		);
		const doneB = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "b", result: { output: "ok", exit_code: 0 } },
			},
			state,
		);
		expect(startA[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "a",
			toolName: "read",
		});
		expect(startB[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "b",
			toolName: "bash",
		});
		expect(doneA[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "a", toolName: "read" });
		expect(doneB[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "b", toolName: "bash" });
		expect(startA[0]?.toolCallId).toBe("a");
		expect(startB[0]?.toolCallId).toBe("b");
		expect(doneA[0]?.toolCallId).toBe("a");
		expect(doneB[0]?.toolCallId).toBe("b");
		expect(state.tools.get("a")).toBe("read");
		expect(state.tools.get("b")).toBe("bash");
		expect(state.tools.size).toBe(2);
	});
});
