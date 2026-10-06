import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";
import { ensureThemeSync, theme } from "../../tui/src/theme/theme";
import { todoToolRenderer } from "../../tui/src/tools/todo";

describe("hermes todo_list mapping", () => {
	it("maps one todo_list id onto the OMP todo renderer", () => {
		ensureThemeSync();
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const todos = [
			{ id: "a", content: "map todo_list", status: "in_progress" },
			{ id: "b", content: "keep one renderer", status: "pending" },
		];
		const start = hermesEventToSessionEvents(
			{ type: "tool.start", payload: { tool_id: "todo-1", name: "todo_list", args: { todos } } },
			state,
		);
		const done = hermesEventToSessionEvents(
			{
				type: "tool.complete",
				payload: { tool_id: "todo-1", name: "todo_list", result: { output: "updated" } },
			},
			state,
		);
		expect(start).toHaveLength(1);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "todo-1",
			toolName: "todo",
			args: { op: "view", items: ["map todo_list", "keep one renderer"] },
		});
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "todo-1",
			toolName: "todo",
		});
		expect(start[0]?.toolCallId).toBe(done[0]?.toolCallId);
		const mapped = todoToolRenderer.renderCall(start[0]!.args as { op: string; items: string[] }, { expanded: false }, theme).render(100);
		const native = todoToolRenderer
			.renderCall({ op: "view", items: ["map todo_list", "keep one renderer"] }, { expanded: false }, theme)
			.render(100);
		expect(mapped).toEqual(native);
	});
});
