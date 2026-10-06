import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes execute_code mapping", () => {
	it("maps execute_code onto one eval card without running code", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const language = "js";
		const code = "console.log(1 + 1)";
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-eval-1", name: "execute_code", args: { language, code } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "tool-eval-1", result: { output: "2" } },
			},
			state,
		);
		expect(start).toHaveLength(1);
		expect(done).toHaveLength(1);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-eval-1",
			toolName: "eval",
			args: { language, code },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-eval-1",
			toolName: "eval",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});
});
