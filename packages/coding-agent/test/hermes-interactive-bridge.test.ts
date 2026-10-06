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

	it("keeps the patch tool id and surfaces lsp_diagnostics on the edit card", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "tool-lsp-1",
					name: "patch",
					args: { path: "foo.ts", old_string: "x", new_string: "y" },
				},
			},
			state,
		);
		const diag =
			'LSP diagnostics introduced by this edit:\n<diagnostics file="foo.ts">\nERROR [1:1] type mismatch\n</diagnostics>';
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: {
					tool_id: "tool-lsp-1",
					result: { files_modified: ["foo.ts"], lsp_diagnostics: diag },
				},
			},
			state,
		);
		expect(start[0]?.toolName).toBe("edit");
		expect(done[0]?.toolName).toBe("edit");
		expect(done[0]?.toolName).not.toBe("lsp");
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		expect(done[0]?.toolCallId).toBe("tool-lsp-1");
		const end = done[0] as {
			result: {
				content: Array<{ text?: string }>;
				details?: { diagnostics?: { messages?: string[]; summary?: string } };
			};
		};
		const text = end.result.content.map((c) => c.text ?? "").join("\n");
		expect(text).toContain("type mismatch");
		expect(end.result.details?.diagnostics?.messages?.some((m) => m.includes("type mismatch"))).toBe(true);
	});
});
