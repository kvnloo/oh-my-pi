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

	it("maps subagent start and complete onto one task card id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "subagent.start",
				payload: { subagent_id: "child-1", name: "Review", task: "Check the empty-title edge case" },
			},
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "subagent.complete", payload: { subagent_id: "child-1", result: { output: "done" } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "child-1",
			toolName: "task",
			args: { name: "Review", task: "Check the empty-title edge case" },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "child-1",
			toolName: "task",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		expect(hermesEventToSessionEvents({ type: "subagent.start", payload: {} }, state)).toEqual([]);
		expect(hermesEventToSessionEvents({ type: "subagent.complete", payload: {} }, state)).toEqual([]);
	});
});
