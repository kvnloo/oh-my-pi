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

	it("maps clarify onto ask so the question is visible without answering", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "tool-ask",
					name: "clarify",
					args: { question: "Which branch should we ship?" },
				},
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-ask",
			toolName: "ask",
			args: {
				questions: [{ id: "clarify", question: "Which branch should we ship?", options: [] }],
			},
		});
		const args = start[0] && "args" in start[0] ? (start[0].args as { questions: Array<{ options: unknown[] }> }) : undefined;
		expect(args?.questions[0]?.options).toEqual([]);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "tool-ask", name: "clarify", result: {} },
			},
			state,
		);
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-ask",
			toolName: "ask",
		});
		const result = done[0] && "result" in done[0] ? done[0].result : undefined;
		expect(result).not.toMatchObject({ details: expect.objectContaining({ selected: expect.anything() }) });
	});
});
