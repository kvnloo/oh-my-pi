import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents, interruptRequest } from "../src/experiments/hermes-interactive-bridge";

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

	it("interruptRequest is session_id only", () => {
		expect(interruptRequest("sess-1")).toEqual({ session_id: "sess-1" });
		expect(interruptRequest("sess-1")).not.toHaveProperty("approve");
	});

	it("second abort still sends session_id and not an approval choice", () => {
		const first = interruptRequest("sess-1");
		const second = interruptRequest("sess-1");
		expect(first).toEqual({ session_id: "sess-1" });
		expect(second).toEqual({ session_id: "sess-1" });
		expect(second).not.toHaveProperty("choice");
		expect(second).not.toHaveProperty("approve");
		expect(second).not.toHaveProperty("approval");
		expect(Object.keys(second)).toEqual(["session_id"]);
	});
});
