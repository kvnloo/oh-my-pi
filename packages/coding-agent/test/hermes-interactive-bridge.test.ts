import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes event mapping", () => {
	it("keeps one tool id from start through complete", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-9", name: "terminal", args: { command: "echo ok" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "tool-9", result_text: "ok" } },
			state,
		);
		expect(start[0]).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-9", toolName: "terminal" });
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-9",
			toolName: "terminal",
			result: { content: [{ type: "text", text: "ok" }] },
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});
});
