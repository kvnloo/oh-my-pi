import { describe, expect, it } from "bun:test";
import {
	type BlockState,
	flushOpenToolCalls,
	processInteractionUpdate,
	type ToolCallState,
} from "@oh-my-pi/pi-ai/providers/cursor";
import type { AssistantMessage, CursorToolResultHandler, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";

const URL = "https://example.com";
const FETCH_ID = "fetch-id";
const ENVELOPE_ID = "env-id";

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6-xhigh-fast",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(onToolResult?: CursorToolResultHandler): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		openToolCalls: new Map(),
		resolvedMcpToolCallIds: new Set(),
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		onToolResult,
	};
}

function fetchToolCall(url: string, toolCallId: string) {
	return {
		toolCallId,
		tool: { case: "fetchToolCall" as const, value: { args: { url, toolCallId } } },
	};
}

describe("Cursor hosted WebFetch interrupted flush", () => {
	it("pairs an interrupted web-fetch when the transport dies before toolCallCompleted", () => {
		// Hosted WebFetch is stamped `kCursorExecResolved` at start, so
		// `agent-loop.ts` synthesizes no placeholder for it and only its
		// `toolCallCompleted` frame pairs a result. A transport that dies first
		// left the call unpaired and `buildSessionContext` strips a dangling
		// call — the whole interaction vanished from every rebuilt transcript.
		// The flush safety net pairs an interrupted error result instead,
		// mirroring connect-scm, todo and cursor-edit.
		const output = cursorAssistantMessage();
		const stream = new AssistantMessageEventStream();
		const paired: ToolResultMessage[] = [];
		const state = newBlockState(result => {
			paired.push(result);
			return result;
		});

		processInteractionUpdate(
			{
				message: {
					case: "toolCallStarted",
					value: { callId: ENVELOPE_ID, toolCall: fetchToolCall(URL, FETCH_ID) },
				},
			},
			output,
			stream,
			state,
			{ sawTokenDelta: false },
		);

		const block = output.content.find((b): b is ToolCallState => b.type === "toolCall");
		if (!block) throw new Error("expected an open web-fetch tool-call block");
		expect(paired).toHaveLength(0);

		flushOpenToolCalls(output, stream, state);

		expect(paired).toHaveLength(1);
		expect(paired[0]?.toolCallId).toBe(block.id);
		expect(paired[0]?.toolName).toBe("web_fetch");
		expect(paired[0]?.isError).toBe(true);
	});
});
