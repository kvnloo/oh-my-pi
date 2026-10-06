import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes browser_navigate", () => {
	it("maps one id onto a card whose target is the URL", () => {
		const url = "https://example.com/docs";
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "nav-1", name: "browser_navigate", args: { url } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "nav-1", result: { output: "navigated" } },
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "nav-1",
			toolName: "browser",
			args: { url },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "nav-1",
			toolName: "browser",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});
});
