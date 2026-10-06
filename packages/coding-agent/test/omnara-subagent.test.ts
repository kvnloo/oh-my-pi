import { describe, expect, it } from "bun:test";

import { createOmnaraBridgeState, omnaraFrameToSessionEvents } from "../src/experiments/omnara-interactive-bridge";

function frame(event: string, payload: unknown) {
	return { event, data: JSON.stringify(payload) };
}

describe("Omnara subagent presentation", () => {
	it("projects spawn_agent through the OMP task renderer with stable identity", () => {
		const state = createOmnaraBridgeState();
		const start = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_spawn",
				model_call_context_id: "ctx_spawn",
				stop_reason: "tool_use",
				content_blocks: [
					{
						type: "tool_call",
						tool_call_id: "spawn_1",
						name: "spawn_agent",
						input: {
							agent: "reviewer",
							name: "Review",
							task: "Check the empty-title edge case",
						},
					},
				],
			}),
			state,
		);
		const toolStart = start.find(event => event.type === "tool_execution_start");
		expect(toolStart).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "spawn_1",
			toolName: "task",
			args: {
				agent: "reviewer",
				name: "Review",
				task: "Check the empty-title edge case",
			},
		});

		const done = omnaraFrameToSessionEvents(
			frame("tool_result", {
				tool_call_id: "spawn_1",
				outcome: "succeeded",
				content_blocks: [
					{
						type: "structured_data",
						value: {
							agent_id: "agt_child_1",
							name: "Review",
							key: "reviewer",
							state: "running",
						},
					},
				],
			}),
			state,
		);
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "spawn_1",
			toolName: "task",
			isError: false,
		});
		expect(JSON.stringify(done[0])).toContain("agt_child_1");
		const startToolId = toolStart && "toolCallId" in toolStart ? toolStart.toolCallId : undefined;
		const doneToolId = done[0] && "toolCallId" in done[0] ? done[0].toolCallId : undefined;
		expect(startToolId).toBe(doneToolId);
	});

	it("does not collapse subagent-owned tool calls into the parent tool id", () => {
		const state = createOmnaraBridgeState();
		state.startedTools.add("parent_spawn");
		state.toolNames.set("parent_spawn", "task");

		const childTool = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_child_tool",
				model_call_context_id: "ctx_child_tool",
				stop_reason: "tool_use",
				content_blocks: [
					{
						type: "tool_call",
						tool_call_id: "child_read_1",
						name: "read_file",
						input: { path: "/memory/project/README.md" },
					},
				],
			}),
			state,
		);
		const toolStart = childTool.find(event => event.type === "tool_execution_start");
		expect(toolStart).toMatchObject({
			toolCallId: "child_read_1",
			toolName: "read",
		});
		expect(toolStart?.toolCallId).not.toBe("parent_spawn");
	});
});
