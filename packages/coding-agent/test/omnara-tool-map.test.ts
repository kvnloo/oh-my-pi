import { describe, expect, it } from "bun:test";

import {
	createOmnaraBridgeState,
	omnaraFrameToSessionEvents,
	omnaraOmpToolArgs,
	omnaraOmpToolName,
} from "../src/experiments/omnara-interactive-bridge";

function frame(event: string, payload: unknown) {
	return { event, data: JSON.stringify(payload) };
}

describe("Omnara → OMP tool presentation map", () => {
	it("maps Omnara built-ins onto the matching OMP renderer contracts", () => {
		expect(omnaraOmpToolName("run_command", { command: "pwd" })).toBe("bash");
		expect(omnaraOmpToolArgs("run_command", { command: "pwd", cwd: "/workspace" })).toEqual({
			command: "pwd",
			cwd: "/workspace",
		});

		expect(omnaraOmpToolName("read_file", { path: "/memory/a" })).toBe("read");
		expect(omnaraOmpToolArgs("read_file", { path: "/memory/a", offset_line: 2, limit_lines: 8 })).toEqual({
			path: "/memory/a",
			offset: 2,
			limit: 8,
		});

		expect(omnaraOmpToolName("list_files", { pattern: "/memory/*.md" })).toBe("glob");
		expect(omnaraOmpToolArgs("list_files", { pattern: "/memory/*.md", limit: 10 })).toEqual({
			path: "/memory/*.md",
			limit: 10,
		});

		expect(omnaraOmpToolName("search_files", { path: "/memory/*", args: ["-i", "-e", "alpha", "-e", "beta"] })).toBe(
			"grep",
		);
		expect(omnaraOmpToolArgs("search_files", { path: "/memory/*", args: ["-i", "-e", "alpha", "-e", "beta"] })).toEqual({
			pattern: "alpha | beta",
			path: "/memory/*",
		});
	});

	it("maps spawn_agent to the existing OMP task surface", () => {
		const state = createOmnaraBridgeState();
		const events = omnaraFrameToSessionEvents(
			frame("model_output", {
				model_call_context_id: "ctx",
				stop_reason: "tool_use",
				content_blocks: [
					{
						type: "tool_call",
						tool_call_id: "spawn-1",
						name: "spawn_agent",
						input: { agent: "reviewer", name: "Review", task: "Review this patch" },
					},
				],
			}),
			state,
		);
		expect(events.find(event => event.type === "tool_execution_start")).toMatchObject({
			toolCallId: "spawn-1",
			toolName: "task",
			args: { agent: "reviewer", name: "Review", task: "Review this patch" },
		});
	});

	it("keeps non-equivalent write_file script calls generic", () => {
		const raw = { path: "/memory/a", script: "transform()" };
		expect(omnaraOmpToolName("write_file", raw)).toBe("write_file");
		expect(omnaraOmpToolArgs("write_file", raw)).toEqual(raw);
	});
});
