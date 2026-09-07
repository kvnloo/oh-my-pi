import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { createInbandScanner, type InbandScanEvent, parseInbandToolMessage } from "@oh-my-pi/pi-ai/dialect";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
] as unknown as readonly { name: string; description: string; parameters: Record<string, unknown> }[];

const START = "<|start|>";
const CHANNEL = "<|channel|>";
const MESSAGE = "<|message|>";
const CALL = "<|call|>";
const END = "<|end|>";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "length",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: usage(),
		stopReason,
		timestamp: 0,
	};
}

function scanEvents(text: string): InbandScanEvent[] {
	const scanner = createInbandScanner("harmony");
	const events: InbandScanEvent[] = [];
	events.push(...scanner.feed(text));
	events.push(...scanner.flush());
	return events;
}

function toolEnds(events: readonly InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }>[] {
	return events.filter((e): e is Extract<InbandScanEvent, { type: "toolEnd" }> => e.type === "toolEnd");
}

function thinkingEnds(events: readonly InbandScanEvent[]): Extract<InbandScanEvent, { type: "thinkingEnd" }>[] {
	return events.filter((e): e is Extract<InbandScanEvent, { type: "thinkingEnd" }> => e.type === "thinkingEnd");
}

function toolCall(name: string, args: Record<string, unknown>, terminated = true): string {
	const body = `${START}assistant${CHANNEL}commentary to=functions.${name}${MESSAGE}${JSON.stringify(args)}`;
	return terminated ? `${body}${CALL}` : body;
}

// A harmony tool body that the model never terminated with `<|call|>` — e.g. the
// stream was truncated by `max_tokens` or a dropped transport chunk, leaving the
// scanner in `body` mode with an empty buffer when `flush()` runs.
describe("harmony scanner: truncated tool body", () => {
	it("emits toolEnd with the accumulated arguments when the body has no <|call|>", () => {
		const events = scanEvents(toolCall("read", { path: "src/a.ts", count: 2, opts: { verbose: true } }, false));
		const ends = toolEnds(events);
		expect(ends).toHaveLength(1);
		expect(ends[0]!.name).toBe("read");
		expect(ends[0]!.arguments).toEqual({ path: "src/a.ts", count: 2, opts: { verbose: true } });
	});

	it("regression: a properly terminated body still parses identically", () => {
		const events = scanEvents(toolCall("read", { path: "src/a.ts" }));
		const ends = toolEnds(events);
		expect(ends).toHaveLength(1);
		expect(ends[0]!.arguments).toEqual({ path: "src/a.ts" });
		expect(ends[0]!.rawBlock).toBe(toolCall("read", { path: "src/a.ts" }));
	});
});

describe("harmony scanner: truncated thinking body", () => {
	it("emits thinkingEnd for an unterminated analysis channel", () => {
		const events = scanEvents(`${START}assistant${CHANNEL}analysis${MESSAGE}partial`);
		expect(thinkingEnds(events)).toHaveLength(1);
	});

	it("regression: a terminated thinking block still emits a single thinkingEnd", () => {
		const events = scanEvents(`${START}assistant${CHANNEL}analysis${MESSAGE}reasoning${END}`);
		expect(thinkingEnds(events)).toHaveLength(1);
	});
});

describe("harmony projector: truncated tool body preserves arguments end-to-end", () => {
	it("parseInbandToolMessage keeps the parsed arguments and the length stopReason", () => {
		const raw = toolCall("read", { path: "src/a.ts", count: 2 }, false);
		const parsed = parseInbandToolMessage(assistant([{ type: "text", text: raw }]), "harmony", TOOLS);
		const calls = parsed.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.name).toBe("read");
		expect(calls[0]!.arguments).toEqual({ path: "src/a.ts", count: 2 });
		// Salvaging tool args from a truncated turn must not rewrite a length
		// stopReason into toolUse.
		expect(parsed.stopReason).toBe("length");
	});
});

describe("harmony scanner: flush never synthesizes spurious close events", () => {
	it("flush on a fresh scanner emits nothing", () => {
		expect(createInbandScanner("harmony").flush()).toEqual([]);
	});

	it("flush after a terminated call does not re-emit a toolEnd", () => {
		const scanner = createInbandScanner("harmony");
		const fed = scanner.feed(toolCall("read", { path: "a.ts" }));
		expect(toolEnds(fed)).toHaveLength(1);
		expect(scanner.flush()).toEqual([]);
	});
});
