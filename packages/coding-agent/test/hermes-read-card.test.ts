import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes read card", () => {
	it("keeps one id and a path target from start through complete", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "read-1", name: "read_file", args: { path: "src/tasks.ts" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: {
					tool_id: "read-1",
					result: { output: "export const taskTitle = (value: string) => value.trim()" },
				},
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "read-1",
			toolName: "read",
			args: { path: "src/tasks.ts" },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		const args = start[0]!.args as { path?: unknown };
		expect(args.path).toBe("src/tasks.ts");
		expect(Object.keys(args)).toContain("path");
		expect(JSON.stringify(args)).not.toMatch(/file count|1 file/i);
	});
});
