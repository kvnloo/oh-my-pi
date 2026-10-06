import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes event mapping", () => {
	it("opens an assistant block before text and keeps the tool id", () => {
		const state = { text: "", model: "hermes", started: false };
		const delta = hermesEventToSessionEvents(
			{ type: "message.delta", payload: { text: "Hello" } },
			state,
		);
		expect(delta.map(event => event.type)).toEqual(["agent_start", "message_start", "message_update"]);
		expect(state.text).toBe("Hello");

		const tool = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-1", name: "read" } },
			state,
		);
		expect(tool[0]).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" });
	});
});
