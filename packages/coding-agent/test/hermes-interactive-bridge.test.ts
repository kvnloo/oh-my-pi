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

	it("maps patch to one edit card on src/tasks.ts with stable id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "edit-1",
					name: "patch",
					args: {
						path: "src/tasks.ts",
						old_string: "export const taskTitle = (value: string) => value.trim()",
						new_string: "export function taskTitle(value: string) { return value.trim() }",
					},
				},
			},
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "edit-1", name: "patch", result: { output: "patched" } },
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "edit-1",
			toolName: "edit",
			args: { path: "src/tasks.ts" },
		});
		expect(done[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "edit-1", toolName: "edit" });
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		const args = start[0]!.args as { path: string };
		expect(args.path).toBe("src/tasks.ts");
	});
});
