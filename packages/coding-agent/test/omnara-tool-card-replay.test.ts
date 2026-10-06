import { describe, expect, it } from "bun:test";

import {
	createOmnaraBridgeState,
	omnaraFrameToSessionEvents,
	omnaraOmpToolArgs,
	omnaraOmpToolName,
} from "../src/experiments/omnara-interactive-bridge";
import { ensureThemeSync, theme } from "../../tui/src/theme/theme";
import { bashToolRenderer } from "../../tui/src/tools/bash";
import { globToolRenderer } from "../../tui/src/tools/glob";
import { grepToolRenderer } from "../../tui/src/tools/grep";
import { readToolRenderer } from "../../tui/src/tools/read";
import { writeToolRenderer } from "../../tui/src/tools/write";

type Args = Record<string, unknown>;
type Renderer = {
	renderCall: (args: Args, options: { expanded: boolean }, uiTheme: typeof theme) => { render: (width: number) => string[] };
};

const renderers: Record<string, Renderer> = {
	bash: bashToolRenderer as unknown as Renderer,
	glob: globToolRenderer as unknown as Renderer,
	grep: grepToolRenderer as unknown as Renderer,
	read: readToolRenderer as unknown as Renderer,
	write: writeToolRenderer as unknown as Renderer,
};

const calls = [
	{
		omnara: "run_command",
		raw: { command: "git status -sb", cwd: "/workspace" },
		omp: "bash",
		expected: { command: "git status -sb", cwd: "/workspace" },
	},
	{
		omnara: "read_file",
		raw: { path: "/memory/project/file.ts", offset_line: 3, limit_lines: 20 },
		omp: "read",
		expected: { path: "/memory/project/file.ts", offset: 3, limit: 20 },
	},
	{
		omnara: "write_file",
		raw: { path: "/memory/project/file.ts", content: "hello" },
		omp: "write",
		expected: { path: "/memory/project/file.ts", content: "hello" },
	},
	{
		omnara: "list_files",
		raw: { pattern: "/memory/project/*.ts", limit: 20 },
		omp: "glob",
		expected: { path: "/memory/project/*.ts", limit: 20 },
	},
	{
		omnara: "search_files",
		raw: { path: "/memory/project/*.ts", args: ["-i", "-e", "needle"] },
		omp: "grep",
		expected: { pattern: "needle", path: "/memory/project/*.ts" },
	},
] as const;

function frame(event: string, payload: unknown) {
	return { event, data: JSON.stringify(payload) };
}

describe("Omnara tool-card replay", () => {
	it("maps built-ins onto existing OMP renderer inputs without changing execution semantics", () => {
		ensureThemeSync();

		for (const [index, call] of calls.entries()) {
			expect(omnaraOmpToolName(call.omnara, call.raw)).toBe(call.omp);
			expect(omnaraOmpToolArgs(call.omnara, call.raw)).toEqual(call.expected);

			const events = omnaraFrameToSessionEvents(
				frame("model_output", {
					id: `evt_${index}`,
					model_call_context_id: `ctx_${index}`,
					stop_reason: "tool_use",
					content_blocks: [
						{
							type: "tool_call",
							tool_call_id: `tool_${index}`,
							name: call.omnara,
							input: call.raw,
						},
					],
				}),
				createOmnaraBridgeState(),
			);
			const start = events.find(event => event.type === "tool_execution_start");
			expect(start).toMatchObject({
				type: "tool_execution_start",
				toolCallId: `tool_${index}`,
				toolName: call.omp,
				args: call.expected,
			});

			const renderer = renderers[call.omp]!;
			const mapped = renderer.renderCall((start as { args: Args }).args, { expanded: false }, theme).render(100);
			const native = renderer.renderCall(call.expected as Args, { expanded: false }, theme).render(100);
			expect(mapped).toEqual(native);
		}
	});

	it("keeps script-based write_file calls generic instead of misrepresenting them as OMP write", () => {
		const raw = { path: "/memory/project/file.ts", script: "replace()" };
		expect(omnaraOmpToolName("write_file", raw)).toBe("write_file");
		expect(omnaraOmpToolArgs("write_file", raw)).toEqual(raw);
	});

	it("surfaces structured Omnara tool results instead of collapsing them to the outcome label", () => {
		const state = createOmnaraBridgeState();
		state.toolNames.set("tool_structured", "task");

		const events = omnaraFrameToSessionEvents(
			frame("tool_result", {
				tool_call_id: "tool_structured",
				outcome: "succeeded",
				content_blocks: [
					{
						type: "structured_data",
						value: { agent_id: "agt_child", state: "running" },
					},
				],
			}),
			state,
		);
		expect(events[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tool_structured",
			toolName: "task",
			result: {
				content: [{ type: "text", text: JSON.stringify({ agent_id: "agt_child", state: "running" }) }],
			},
		});
	});
});
