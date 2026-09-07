import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { addDelegatedUsage } from "../src/tb/trial";
import type { TrialUsage } from "../src/tb/types";

function baseUsage(): TrialUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };
}

function readResult(details: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "answer" }],
		details,
		isError: false,
		timestamp: 1,
	} as unknown as AgentMessage;
}

function taskResult(details: unknown): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "task",
		content: [{ type: "text", text: "subagent" }],
		details,
		isError: false,
		timestamp: 2,
	} as unknown as AgentMessage;
}

function assistantMessage(): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "thinking..." }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o",
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		stopReason: "stop",
		timestamp: 3,
	} as unknown as AgentMessage;
}

const DELEGATED_USAGE = {
	input: 12,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 19,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 },
};

describe("addDelegatedUsage", () => {
	it("folds read toolResult.details.usage into the trial totals", () => {
		const usage = baseUsage();
		const messages: AgentMessage[] = [
			readResult({ resolvedPath: "/x.png", contentType: "image/png", usage: DELEGATED_USAGE }),
		];

		addDelegatedUsage(messages, usage);

		expect(usage).toEqual({
			input: 12,
			output: 4,
			cacheRead: 2,
			cacheWrite: 1,
			costUsd: 0.33,
			turns: 0,
		});
	});

	it("accumulates delegated usage across multiple read ?q= results", () => {
		const usage = baseUsage();
		const messages: AgentMessage[] = [
			readResult({
				usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 6, cost: { total: 0.04 } },
			}),
			readResult({
				usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 19, cost: { total: 0.06 } },
			}),
		];

		addDelegatedUsage(messages, usage);

		expect(usage).toEqual({ input: 15, output: 3, cacheRead: 3, cacheWrite: 4, costUsd: 0.1, turns: 0 });
	});

	it("is additive on top of session-stats totals and preserves turns", () => {
		const usage: TrialUsage = { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, costUsd: 1.5, turns: 3 };

		addDelegatedUsage([readResult({ usage: DELEGATED_USAGE })], usage);

		expect(usage).toEqual({ input: 112, output: 54, cacheRead: 12, cacheWrite: 6, costUsd: 1.83, turns: 3 });
	});

	it("ignores non-read tool results (task usage belongs to getSessionStats)", () => {
		const usage = baseUsage();

		addDelegatedUsage(
			[
				taskResult({
					usage: {
						input: 999,
						output: 999,
						cacheRead: 999,
						cacheWrite: 999,
						totalTokens: 999,
						cost: { total: 9.99 },
					},
				}),
			],
			usage,
		);

		expect(usage).toEqual(baseUsage());
	});

	it("ignores assistant messages in the transcript", () => {
		const usage = baseUsage();

		addDelegatedUsage([assistantMessage()], usage);

		expect(usage).toEqual(baseUsage());
	});

	it("ignores read results without a details.usage record", () => {
		const usage = baseUsage();
		const messages: AgentMessage[] = [
			readResult({ resolvedPath: "/a.txt", contentType: "text/plain" }),
			readResult({ usage: undefined }),
			readResult({}),
			readResult(null),
			readResult(undefined),
		];

		addDelegatedUsage(messages, usage);

		expect(usage).toEqual(baseUsage());
	});

	it("ignores malformed usage records (non-numeric fields)", () => {
		const usage = baseUsage();
		const messages: AgentMessage[] = [
			readResult({
				usage: {
					input: "no",
					output: true,
					cacheRead: null,
					cacheWrite: "1",
					totalTokens: "x",
					cost: { total: "y" },
				},
			}),
			readResult({ usage: { cost: 5 } }),
			readResult({ usage: { input: 1, cost: { total: "not a number" } } }),
		];

		addDelegatedUsage(messages, usage);

		expect(usage).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 });
	});

	it("does not mutate the input messages array", () => {
		const usage = baseUsage();
		const messages: AgentMessage[] = [readResult({ usage: DELEGATED_USAGE })];
		const snapshot = messages.map(message => ({ ...message }));

		addDelegatedUsage(messages, usage);

		expect(messages).toEqual(snapshot);
	});
});
