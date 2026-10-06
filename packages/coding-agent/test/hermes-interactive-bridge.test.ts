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

	it("maps search_files content onto grep with pattern and one tool id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "tool-grep-1",
					name: "search_files",
					args: { pattern: "tool_execution_start", path: "event-controller.ts", target: "content" },
				},
			},
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "tool-grep-1", result: { output: "tool_execution_start", exit_code: 0 } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-grep-1",
			toolName: "grep",
			args: { pattern: "tool_execution_start", path: "event-controller.ts" },
		});
		expect(done[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "tool-grep-1", toolName: "grep" });
	});

	it("keeps one tool id and writes path plus content", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const path = "packages/coding-agent/test/hermes-interactive-bridge.test.ts";
		const content = "replay";
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-write-1", name: "write_file", args: { path, content } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-write-1",
			toolName: "write",
			args: { path, content },
		});
	});

	it("maps write_file file_path to OMP write path", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-write-2", name: "write_file", args: { file_path: "notes.md", content: "hello" } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-write-2",
			toolName: "write",
			args: { path: "notes.md", content: "hello" },
		});
	});

	it("maps web_search onto the OMP query renderer with one id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "search-1", name: "web_search", args: { query: "bun vs node" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "search-1", result: { output: "cached-results" } } },
			state,
		);
		expect(start[0]).toMatchObject({ type: "tool_execution_start", toolCallId: "search-1", toolName: "web_search", args: { query: "bun vs node" } });
		expect(done[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "search-1", toolName: "web_search" });
	});

	it("keeps the patch tool id and surfaces lsp_diagnostics on the edit card", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-lsp-1", name: "patch", args: { path: "foo.ts", old_string: "x", new_string: "y" } } },
			state,
		);
		const diag = "LSP diagnostics introduced by this edit:\nERROR [1:1] type mismatch";
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "tool-lsp-1", result: { files_modified: ["foo.ts"], lsp_diagnostics: diag } } },
			state,
		);
		expect(start[0]?.toolName).toBe("edit");
		expect(done[0]?.toolName).toBe("edit");
		expect(done[0]?.toolCallId).toBe("tool-lsp-1");
		const end = done[0] as { result: { content: Array<{ text?: string }>; details?: { diagnostics?: { messages?: string[] } } } };
		expect(end.result.content.map((part) => part.text ?? "").join("\n")).toContain("type mismatch");
		expect(end.result.details?.diagnostics?.messages?.some((line) => line.includes("type mismatch"))).toBe(true);
	});

	it("maps clarify onto ask so the question is visible without answering", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-ask", name: "clarify", args: { question: "Which branch should we ship?" } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "tool-ask",
			toolName: "ask",
			args: { questions: [{ id: "clarify", question: "Which branch should we ship?", options: [] }] },
		});
	});

	it("interruptRequest is session_id only", () => {
		expect(interruptRequest("sess-1")).toEqual({ session_id: "sess-1" });
		expect(interruptRequest("sess-1")).not.toHaveProperty("approve");
		expect(Object.keys(interruptRequest("sess-1"))).toEqual(["session_id"]);
	});

	it("maps subagent start and complete onto one task card id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{ type: "subagent.start", payload: { subagent_id: "child-1", name: "Review", task: "Check the empty-title edge case" } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "subagent.complete", payload: { subagent_id: "child-1", result: { output: "done" } } },
			state,
		);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "child-1",
			toolName: "task",
			args: { name: "Review", task: "Check the empty-title edge case" },
		});
		expect(done[0]).toMatchObject({ type: "tool_execution_end", toolCallId: "child-1", toolName: "task" });
		expect(hermesEventToSessionEvents({ type: "subagent.start", payload: {} }, state)).toEqual([]);
	});

	it("maps duration_s onto the same tool id as wallTimeMs", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "tool-took", name: "terminal", args: { command: "sleep 1" } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "tool-took", duration_s: 1.5, result: { output: "ok", exit_code: 0 } } },
			state,
		);
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool-took",
			toolName: "bash",
			result: { details: { exitCode: 0, wallTimeMs: 1500 } },
		});
	});

	it("keeps two tool ids for read_file and terminal in one stream", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const startA = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "a", name: "read_file", args: { path: "README.md" } } },
			state,
		);
		const startB = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "b", name: "terminal", args: { command: "echo ok" } } },
			state,
		);
		const doneA = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "a", result: { output: "readme", exit_code: 0 } } },
			state,
		);
		const doneB = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "b", result: { output: "ok", exit_code: 0 } } },
			state,
		);
		expect(startA[0]?.toolCallId).toBe("a");
		expect(startB[0]?.toolCallId).toBe("b");
		expect(doneA[0]?.toolName).toBe("read");
		expect(doneB[0]?.toolName).toBe("bash");
		expect(state.tools.size).toBe(2);
	});

	it("maps patch to one edit card on src/tasks.ts with stable id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "edit-1",
					name: "patch",
					args: { path: "src/tasks.ts", old_string: "a", new_string: "b" },
				},
			},
			state,
		);
		const done = hermesEventToSessionEvents(
			{ type: "tool.complete", payload: { tool_id: "edit-1", name: "patch", result: { output: "patched" } } },
			state,
		);
		expect(start[0]).toMatchObject({ toolCallId: "edit-1", toolName: "edit", args: { path: "src/tasks.ts" } });
		expect(done[0]).toMatchObject({ toolCallId: "edit-1", toolName: "edit" });
	});
});
