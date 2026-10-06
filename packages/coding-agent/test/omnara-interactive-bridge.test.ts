import { describe, expect, it } from "bun:test";

import { createOmnaraBridgeState, omnaraFrameToSessionEvents } from "../src/experiments/omnara-interactive-bridge";

function frame(event: string, payload: unknown, id?: string) {
	return { event, id, data: JSON.stringify(payload) };
}

describe("Omnara InteractiveMode event mapping", () => {
	it("suppresses the durable echo of a locally optimistic input", () => {
		const state = createOmnaraBridgeState();
		state.localInputKeys.add("local-1");

		const events = omnaraFrameToSessionEvents(
			frame("agent_input", {
				event_kind: "agent_input",
				input_kind: "content",
				input_idempotency_key: "local-1",
				content_blocks: [{ type: "text", text: "hello" }],
			}),
			state,
		);

		expect(events).toEqual([]);
		expect(state.localInputKeys.has("local-1")).toBe(false);
	});

	it("renders remote inputs as normal user-message lifecycle events", () => {
		const state = createOmnaraBridgeState();
		const events = omnaraFrameToSessionEvents(
			frame("agent_input", {
				event_kind: "agent_input",
				input_kind: "content",
				content_blocks: [{ type: "text", text: "from dashboard" }],
			}),
			state,
		);

		expect(events.map(event => event.type)).toEqual(["agent_start", "message_start", "message_end"]);
		expect(events[1]).toMatchObject({ message: { role: "user", content: "from dashboard" } });
		expect(state.turnActive).toBe(true);
	});

	it("honors Omnara hidden/display metadata in user content", () => {
		const state = createOmnaraBridgeState();
		const events = omnaraFrameToSessionEvents(
			frame("agent_input", {
				event_kind: "agent_input",
				input_kind: "content",
				content_blocks: [
					{ type: "text", text: "source hint", metadata: { omnara_hidden: "true" } },
					{ type: "text", text: "wire text", metadata: { omnara_display_text: "visible text" } },
				],
			}),
			state,
		);

		expect(events[1]).toMatchObject({ message: { role: "user", content: "visible text" } });
	});

	it("settles a remote Omnara control event", () => {
		const state = createOmnaraBridgeState();
		state.turnActive = true;

		const events = omnaraFrameToSessionEvents(
			frame("agent_input", {
				event_kind: "agent_input",
				input_kind: "control",
				control_type: "cancel",
			}),
			state,
		);

		expect(events).toEqual([{ type: "agent_end", messages: [], isTerminal: true, yielded: true }]);
		expect(state.turnActive).toBe(false);
	});

	it("uses Omnara's no-more-work rule for model outputs", () => {
		const state = createOmnaraBridgeState();
		state.turnActive = true;

		const events = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_unusual",
				model_call_context_id: "mcc_unusual",
				stop_reason: "tool_use",
				content_blocks: [{ type: "text", text: "No tool was actually requested." }],
			}),
			state,
		);

		expect(events.at(-1)?.type).toBe("agent_end");
		expect(state.turnActive).toBe(false);
	});

	it("accumulates model deltas and terminates only on terminal Omnara stops", () => {
		const state = createOmnaraBridgeState("remote-model");

		const first = omnaraFrameToSessionEvents(
			frame("model_output_delta", {
				model_call_context_id: "mcc_1",
				event: { kind: "text_delta", delta: "Hel" },
			}),
			state,
		);
		const second = omnaraFrameToSessionEvents(
			frame("model_output_delta", {
				model_call_context_id: "mcc_1",
				event: { kind: "text_delta", delta: "lo" },
			}),
			state,
		);

		expect(first.map(event => event.type)).toEqual(["agent_start", "message_start", "message_update"]);
		expect(second.map(event => event.type)).toEqual(["message_update"]);
		expect(second[0]).toMatchObject({ message: { content: [{ type: "text", text: "Hello" }] } });

		const continued = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_1",
				model_call_context_id: "mcc_1",
				stop_reason: "max_tokens",
				content_blocks: [{ type: "text", text: "Hello" }],
			}),
			state,
		);
		expect(continued.map(event => event.type)).toEqual(["message_end"]);
		expect(continued.some(event => event.type === "agent_end")).toBe(false);

		const terminal = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_2",
				model_call_context_id: "mcc_2",
				stop_reason: "end_turn",
				content_blocks: [{ type: "text", text: "Done" }],
			}),
			state,
		);
		expect(terminal.map(event => event.type)).toEqual(["message_start", "message_end", "agent_end"]);
	});

	it("does not settle a tool_use output before the tool lifecycle arrives", () => {
		const state = createOmnaraBridgeState();
		const events = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_tool_partial",
				model_call_context_id: "mcc_tool_partial",
				stop_reason: "tool_use",
				content_blocks: [],
			}),
			state,
		);

		expect(events.map(event => event.type)).toEqual(["agent_start", "message_start", "message_end"]);
		expect(events.some(event => event.type === "agent_end")).toBe(false);
	});

	it("keeps Omnara tool identity through request and result", () => {
		const state = createOmnaraBridgeState();
		const start = omnaraFrameToSessionEvents(
			frame("model_output", {
				id: "evt_tool",
				model_call_context_id: "mcc_tool",
				stop_reason: "tool_use",
				content_blocks: [
					{
						type: "tool_call",
						tool_call_id: "tcl_1",
						name: "search",
						input: { query: "needle" },
					},
				],
			}),
			state,
		);
		expect(start).toContainEqual({
			type: "tool_execution_start",
			toolCallId: "tcl_1",
			toolName: "search",
			args: { query: "needle" },
		});
		expect(start.some(event => event.type === "agent_end")).toBe(false);

		const done = omnaraFrameToSessionEvents(
			frame("tool_result", {
				tool_call_id: "tcl_1",
				outcome: "failed",
				content_blocks: [{ type: "text", text: "no match" }],
			}),
			state,
		);
		expect(done[0]).toMatchObject({
			type: "tool_execution_end",
			toolCallId: "tcl_1",
			toolName: "search",
			isError: true,
		});
	});
});
