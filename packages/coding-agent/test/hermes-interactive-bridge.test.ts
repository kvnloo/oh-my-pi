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

	it("keeps one tool id and writes path plus content", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const path = "packages/coding-agent/test/hermes-interactive-bridge.test.ts";
		const content = "replay";
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-write-1", name: "write_file", args: { path, content } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "tool-write-1", result: { output: "wrote" } },
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-write-1",
			toolName: "write",
			args: { path, content },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-write-1",
			toolName: "write",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		const startEvent = start[0];
		if (!startEvent || startEvent.type !== "tool_execution_start") throw new Error("expected start");
		const args = startEvent.args;
		if (!args || typeof args !== "object") throw new Error("expected args");
		expect("path" in args && args.path).toBe(path);
		expect("content" in args && args.content).toBe(content);
		expect("count" in args).toBe(false);
	});

	it("maps write_file file_path to OMP write path", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "tool-write-2",
					name: "write_file",
					args: { file_path: "notes.md", content: "hello" },
				},
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-write-2",
			toolName: "write",
			args: { path: "notes.md", content: "hello" },
		});
	});
});
