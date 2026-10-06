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

	it("maps web_search onto the OMP query renderer with one id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "search-1", name: "web_search", args: { query: "bun vs node" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "search-1", result: { output: "cached-results" } },
			},
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "search-1",
			toolName: "web_search",
			args: { query: "bun vs node" },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "search-1",
			toolName: "web_search",
			result: { content: [{ type: "text", text: "cached-results" }] },
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
	});
});
