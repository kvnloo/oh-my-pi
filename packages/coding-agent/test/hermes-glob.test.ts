import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes search_files files → glob", () => {
	it("maps file-name search to glob with renderer path and one tool id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "glob-1",
					name: "search_files",
					args: { pattern: "*.yml", path: ".github/workflows", target: "files" },
				},
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "glob-1",
			toolName: "glob",
			args: { path: "*.yml" },
		});
		expect(start[0]?.toolName).not.toBe("grep");
		expect(start[0] && "args" in start[0] && start[0].args && typeof start[0].args === "object" && "path" in start[0].args ? start[0].args.path : undefined).toBe("*.yml");

		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "glob-1", name: "search_files", result: { output: "ci.yml" } },
			},
			state,
		);
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "glob-1",
			toolName: "glob",
		});
		expect(done[0]?.toolName).not.toBe("grep");
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});
});
