import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";
import { ensureThemeSync, theme } from "../../tui/src/theme/theme";
import { bashToolRenderer } from "../../tui/src/tools/bash";
import { editToolRenderer } from "../../tui/src/tools/edit";
import { globToolRenderer } from "../../tui/src/tools/glob";
import { grepToolRenderer } from "../../tui/src/tools/grep";
import { readToolRenderer } from "../../tui/src/tools/read";
import { writeToolRenderer } from "../../tui/src/tools/write";

type Args = Record<string, unknown>;
type Replay = { hermes: string; args: Args; output: string; omp: string; expectArgs: Args };

const calls: Replay[] = [
	{ hermes: "terminal", args: { command: "echo tool-card-ok" }, output: "tool-card-ok", omp: "bash", expectArgs: { command: "echo tool-card-ok" } },
	{ hermes: "terminal", args: { command: "git status -sb" }, output: "## exp/hermes-tool-cards", omp: "bash", expectArgs: { command: "git status -sb" } },
	{ hermes: "terminal", args: { command: "bun test test/hermes-interactive-bridge.test.ts" }, output: "1 pass", omp: "bash", expectArgs: { command: "bun test test/hermes-interactive-bridge.test.ts" } },
	{ hermes: "terminal", args: { command: "ls packages/natives/native" }, output: "loader-state.js", omp: "bash", expectArgs: { command: "ls packages/natives/native" } },
	{ hermes: "shell", args: { command: "gitnexus doctor", cwd: "/tmp" }, output: "VECTOR extension: available", omp: "bash", expectArgs: { command: "gitnexus doctor", cwd: "/tmp" } },
	{ hermes: "read_file", args: { path: "packages/coding-agent/src/experiments/hermes-interactive-bridge.ts" }, output: "function ompToolName", omp: "read", expectArgs: { path: "packages/coding-agent/src/experiments/hermes-interactive-bridge.ts", offset: undefined, limit: undefined } },
	{ hermes: "read_file", args: { path: "packages/coding-agent/test/hermes-interactive-bridge.test.ts", offset: 1, limit: 30 }, output: "describe", omp: "read", expectArgs: { path: "packages/coding-agent/test/hermes-interactive-bridge.test.ts", offset: 1, limit: 30 } },
	{ hermes: "read_file", args: { path: "tools/file_tools.py", offset: 1270, limit: 40 }, output: "SEARCH_FILES_SCHEMA", omp: "read", expectArgs: { path: "tools/file_tools.py", offset: 1270, limit: 40 } },
	{ hermes: "read_file", args: { path: "packages/tui/src/tools/bash.ts" }, output: "bashToolRenderer", omp: "read", expectArgs: { path: "packages/tui/src/tools/bash.ts", offset: undefined, limit: undefined } },
	{ hermes: "read_file", args: { path: "packages/tui/src/theme/theme.ts", offset: 90, limit: 10 }, output: "export var theme", omp: "read", expectArgs: { path: "packages/tui/src/theme/theme.ts", offset: 90, limit: 10 } },
	{ hermes: "search_files", args: { pattern: "tool_execution_start", path: "packages/coding-agent/src/modes/controllers/event-controller.ts", target: "content" }, output: "tool_execution_start", omp: "grep", expectArgs: { pattern: "tool_execution_start", path: "packages/coding-agent/src/modes/controllers/event-controller.ts" } },
	{ hermes: "search_files", args: { pattern: "describeCall", path: "packages/tui/src/tools", target: "content" }, output: "describeCall", omp: "grep", expectArgs: { pattern: "describeCall", path: "packages/tui/src/tools" } },
	{ hermes: "search_files", args: { pattern: "registry.register", path: "tools/file_tools.py", target: "content" }, output: "read_file", omp: "grep", expectArgs: { pattern: "registry.register", path: "tools/file_tools.py" } },
	{ hermes: "search_files", args: { pattern: "GITNEXUS_LBUG_BUFFER_POOL_SIZE", path: "dist/core/lbug/lbug-config.js", target: "content" }, output: "buffer pool", omp: "grep", expectArgs: { pattern: "GITNEXUS_LBUG_BUFFER_POOL_SIZE", path: "dist/core/lbug/lbug-config.js" } },
	{ hermes: "search_files", args: { pattern: "renderCall", path: "packages/tui/src/tools/read.ts", target: "content" }, output: "renderCall", omp: "grep", expectArgs: { pattern: "renderCall", path: "packages/tui/src/tools/read.ts" } },
	{ hermes: "search_files", args: { pattern: "*.yml", path: ".github/workflows", target: "files" }, output: "ci.yml", omp: "glob", expectArgs: { path: "*.yml" } },
	{ hermes: "search_files", args: { pattern: "package.json", target: "files" }, output: "package.json", omp: "glob", expectArgs: { path: "package.json" } },
	{ hermes: "patch", args: { path: "hermes-interactive-bridge.ts", old_string: "return name;", new_string: "return \"bash\";" }, output: "patched", omp: "edit", expectArgs: { path: "hermes-interactive-bridge.ts", oldText: "return name;", newText: "return \"bash\";", patch: undefined } },
	{ hermes: "write_file", args: { path: "test/hermes-tool-card-replay.test.ts", content: "replay" }, output: "wrote", omp: "write", expectArgs: { path: "test/hermes-tool-card-replay.test.ts", content: "replay" } },
	{ hermes: "terminal", args: { command: "echo fail; exit 1" }, output: "fail", omp: "bash", expectArgs: { command: "echo fail; exit 1" } },
];

const renderers = {
	bash: bashToolRenderer,
	read: readToolRenderer,
	grep: grepToolRenderer,
	glob: globToolRenderer,
	edit: editToolRenderer,
	write: writeToolRenderer,
} as const;

function cardText(kind: keyof typeof renderers, args: Args, output: string): string[] {
	const renderer = renderers[kind] as {
		renderCall: (args: Args, options: { expanded: boolean }, uiTheme: typeof theme) => { render: (width: number) => string[] };
		renderResult?: (result: unknown, options: { expanded: boolean }, uiTheme: typeof theme, args: Args) => { render: (width: number) => string[] };
	};
	const call = renderer.renderCall(args, { expanded: false }, theme).render(100);
	const result = renderer.renderResult?.(
		{ content: [{ type: "text", text: output }], isError: false },
		{ expanded: false },
		theme,
		args,
	);
	return [...call, ...(result ? result.render(100) : [])];
}

describe("hermes tool card replay", () => {
	it("renders 20 session calls the same as the OMP cards", () => {
		ensureThemeSync();
		expect(calls).toHaveLength(20);
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		for (const [index, call] of calls.entries()) {
			const start = hermesEventToSessionEvents(
				{ type: "tool.start", payload: { tool_id: `tool-${index}`, name: call.hermes, args: call.args } },
				state,
			);
			expect(start[0]).toMatchObject({ type: "tool_execution_start", toolName: call.omp, args: call.expectArgs });
			const mapped = cardText(call.omp as keyof typeof renderers, start[0]!.args as Args, call.output);
			const native = cardText(call.omp as keyof typeof renderers, call.expectArgs, call.output);
			expect(mapped).toEqual(native);
		}
	});
});
