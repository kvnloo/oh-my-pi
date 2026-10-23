import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as AIError from "../../src/error";
import { parseRateLimitReason } from "../../src/error/rate-limit";
import type { Context, FetchImpl, Model } from "../../src/types";
import {
	createCodexProviderStreamError,
	isRetryableCodexFailureEvent,
	streamOpenAICodexResponses,
} from "../../src/providers/openai-codex-responses";

describe("isRetryableCodexFailureEvent", () => {
	it("classifies retryable codes from nested error.code, error.type, then rawEvent.code", () => {
		expect(isRetryableCodexFailureEvent({ error: { code: "server_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ error: { type: "internal_error" } })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "model_error" })).toBe(true);
	});

	it("prefers nested error.code over the top-level code (matching the factory)", () => {
		// The error.code chain wins, so a non-retryable nested code with no retryable message
		// is NOT retryable even though the top-level code is retryable.
		expect(isRetryableCodexFailureEvent({ code: "server_error", error: { code: "bad_request" } })).toBe(false);
	});

	it("detects retryable messages when the code is absent or unknown", () => {
		expect(isRetryableCodexFailureEvent({ message: "Please retry your request shortly" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "we are overloaded" })).toBe(true);
		expect(isRetryableCodexFailureEvent({ response: { message: "service unavailable" } })).toBe(true);
	});

	it("returns false for non-retryable code and message", () => {
		expect(isRetryableCodexFailureEvent({ code: "bad_request", message: "invalid input" })).toBe(false);
		expect(isRetryableCodexFailureEvent({})).toBe(false);
	});

	it.each([
		"generic provider failure",
		"malformed chunk footer",
		"<StreamReset stream_id:1283, error_code:8, remote_reset:True>",
		"<StreamReset stream_id:1283, error_code:2, remote_reset:False>",
	])("keeps api_error with %s outside transport retry", message => {
		expect(isRetryableCodexFailureEvent({ type: "error", error: { type: "api_error", message } })).toBe(false);
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		expect(isRetryableCodexFailureEvent({ error: "boom", response: { error: { code: "server_error" } } })).toBe(true);
	});

	it("ignores mistyped fields instead of failing the whole parse", () => {
		// A numeric top-level `code` must not poison parsing; the retryable message is still honored.
		expect(isRetryableCodexFailureEvent({ code: 500, message: "internal error while processing" })).toBe(true);
		// Same tolerance nested: a non-string error.code is dropped while a valid error.message survives.
		expect(isRetryableCodexFailureEvent({ error: { code: 123, message: "server error happened" } })).toBe(true);
	});
});

describe("createCodexProviderStreamError", () => {
	it("prefers nested error.code over the top-level code (aligned with isRetryable)", () => {
		expect(createCodexProviderStreamError({ code: "outer_code", error: { code: "inner_code" } }).code).toBe(
			"inner_code",
		);
	});

	it("falls back to nested error.code then error.type", () => {
		expect(createCodexProviderStreamError({ error: { code: "inner_code" } }).code).toBe("inner_code");
		expect(createCodexProviderStreamError({ error: { type: "inner_type" } }).code).toBe("inner_type");
	});

	it("leaves code undefined when nothing supplies one", () => {
		expect(createCodexProviderStreamError({ message: "boom" }).code).toBeUndefined();
	});

	it("marks retryable error events and formats them as error events", () => {
		const err = createCodexProviderStreamError({ type: "error", code: "server_error", message: "kaboom" });
		expect(err.retryable).toBe(true);
		expect(err.code).toBe("server_error");
		expect(err.message).toContain("error event");
		expect(err.message).toContain("kaboom");
	});

	it("preserves a refused remote stream diagnostic while enabling nested response-failure retry", () => {
		const message = "<StreamReset stream_id:1283, error_code:7, remote_reset:True>";
		const err = createCodexProviderStreamError({
			type: "response.failed",
			response: { error: { type: "api_error", message } },
		});
		expect(err.retryable).toBe(true);
		expect(err.code).toBe("api_error");
		expect(err.message).toContain(message);
	});

	it("formats non-error failures via the response-failure path", () => {
		const err = createCodexProviderStreamError({
			type: "response.failed",
			response: { error: { message: "downstream blew up" } },
		});
		expect(err.retryable).toBe(false);
		expect(err.code).toBeUndefined();
		expect(err.message).toContain("response failed");
		expect(err.message).toContain("downstream blew up");
	});

	it("falls back to response.error when rawEvent.error is not an object", () => {
		const err = createCodexProviderStreamError({
			error: "boom",
			response: { error: { code: "server_error", message: "nested boom" } },
		});
		expect(err.code).toBe("server_error");
		expect(err.retryable).toBe(true);
		expect(err.message).toContain("nested boom");
	});
});

// #158 M1 / #78: offline provider-boundary tests, not reserve-tier policy.
// In particular, a synthetic reserve hint is not consent or a verified entitlement.
const FAILURE_EVENTS = [
	{
		label: "exhausted plan quota",
		event: {
			type: "error",
			error: { code: "usage_limit_reached", message: "The usage limit has been reached" },
			reserve: { eligible: true, tier: "gpt-reserve" },
		},
		code: "usage_limit_reached",
		reason: "QUOTA_EXHAUSTED",
		usageLimit: true,
		authFailed: false,
	},
	{
		label: "per-minute rate limit",
		event: {
			type: "response.failed",
			response: { error: { code: "rate_limit_exceeded", message: "Requests per minute limit reached" } },
		},
		code: "rate_limit_exceeded",
		reason: "RATE_LIMIT_EXCEEDED",
		usageLimit: false,
		authFailed: false,
	},
	{
		label: "invalid authentication",
		event: { type: "error", error: { code: "invalid_api_key", message: "Invalid API key" } },
		code: "invalid_api_key",
		reason: "UNKNOWN",
		usageLimit: false,
		authFailed: true,
	},
] as const;

describe("Codex quota / auth / throttle boundary (#158 M1)", () => {
	it.each(FAILURE_EVENTS)("classifies $label without treating it as a transport retry", failure => {
		const error = createCodexProviderStreamError(failure.event);
		expect(error.code).toBe(failure.code);
		expect(error.message).toContain(failure.code);
		expect(error.retryable).toBe(false);
		expect(isRetryableCodexFailureEvent(failure.event)).toBe(false);
		expect(parseRateLimitReason(error.message)).toBe(failure.reason);
		expect(AIError.isUsageLimit(error, "openai-codex-responses")).toBe(failure.usageLimit);
		expect(AIError.is(AIError.classify(error, "openai-codex-responses"), AIError.Flag.AuthFailed)).toBe(
			failure.authFailed,
		);
	});
});

describe("Codex synthetic stream retry and tier boundary (#158 M1)", () => {
	const model: Model<"openai-codex-responses"> = buildModel({
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		preferWebsockets: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	});
	const context: Context = {
		systemPrompt: ["You are a helpful assistant."],
		messages: [{ role: "user", content: "Hello", timestamp: 1_700_000_000_000 }],
	};
	const tokenPayload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } }),
		"utf8",
	).toBase64();
	const syntheticToken = ["aaa", tokenPayload, "bbb"].join(".");

	beforeEach(() => {
		vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function decodeRequestBody(body: RequestInit["body"]): Record<string, unknown> {
		const raw =
			typeof body === "string"
				? body
				: body instanceof Uint8Array
					? new TextDecoder().decode(Bun.zstdDecompressSync(body))
					: undefined;
		if (raw === undefined) throw new Error("expected an offline Codex request body");
		return JSON.parse(raw) as Record<string, unknown>;
	}

	function syntheticSseFetch(event: Record<string, unknown>, sent: Array<Record<string, unknown>>): FetchImpl {
		return async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== "https://chatgpt.com/backend-api/codex/responses") {
				throw new Error("unexpected outbound request: " + url);
			}
			sent.push(decodeRequestBody(init?.body));
			return new Response("data: " + JSON.stringify(event) + "\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
	}

	function expectUnchangedIncludedTier(sent: Array<Record<string, unknown>>): void {
		for (const request of sent) {
			expect(request.model).toBe(model.requestModelId ?? model.id);
			expect(request).not.toHaveProperty("service_tier");
			expect(JSON.stringify(request)).not.toContain("gpt-reserve");
		}
	}

	it.each(FAILURE_EVENTS)("surfaces $label once without retrying or selecting a reserve tier", async failure => {
		const sent: Array<Record<string, unknown>> = [];
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: syntheticToken,
			fetch: syntheticSseFetch(failure.event, sent),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(failure.code);
		expect(sent).toHaveLength(1);
		expect(waitSpy).not.toHaveBeenCalled();
		expectUnchangedIncludedTier(sent);
	});

	it("bounds replay-safe transient server failures to five backoffs, never escalating tiers", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const waitSpy = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const result = await streamOpenAICodexResponses(model, context, {
			apiKey: syntheticToken,
			fetch: syntheticSseFetch(
				{ type: "response.failed", response: { error: { code: "server_error", message: "Server error" } } },
				sent,
			),
		}).result();

		const delays = waitSpy.mock.calls.map(([delay]) => delay);
		expect(delays).toEqual([500, 1_000, 1_500, 2_000, 2_500]);
		expect(delays.reduce((total, delay) => total + delay, 0)).toBe(7_500);
		expect(sent).toHaveLength(6);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("server_error");
		expectUnchangedIncludedTier(sent);
	});
});
