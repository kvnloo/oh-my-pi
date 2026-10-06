import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes event mapping", () => {
	it("appends assistant text and keeps the tool id", () => {
		const state = { text: "", model: "hermes" };
		const delta = hermesEventToSessionEvents(
			{ type: "message.delta", payload: { text: "Hello" } },
			state,
		);
		expect(delta[0]?.type).toBe("message_update");
		expect(state.text).toBe("Hello");

		const tool = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-1", name: "read" } },
			state,
		);
		expect(tool[0]).toMatchObject({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read" });

		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "tool-1", name: "read", error: "nope" } },
			state,
		);
		expect(done[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "tool-1", isError: true });
	});
});
