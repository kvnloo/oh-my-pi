import { describe, expect, test } from "bun:test";
import cognitiveStateShadowExtension, { createShadowCompilerState } from "../src/extension.ts";

type Handler = (event: unknown, ctx?: unknown) => Promise<unknown> | unknown;

function mockPi() {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		_handlers: handlers,
	};
	return api;
}

describe("extension shadow-only contract", () => {
	test("context handler returns undefined (no message replace)", async () => {
		const pi = mockPi();
		cognitiveStateShadowExtension(pi as never);
		const contextHandlers = pi._handlers.get("context") ?? [];
		expect(contextHandlers.length).toBe(1);
		const result = await contextHandlers[0]!({
			type: "context",
			messages: [
				{ role: "user", content: "Hello. Do not switch provider context." },
				{ role: "tool", toolName: "bash", toolCallId: "1", content: "ok\nexit code: 0\n" + "y".repeat(3000) },
			],
		});
		expect(result).toBeUndefined();
		const state = (pi as unknown as { _cognitiveStateShadow: ReturnType<typeof createShadowCompilerState> })
			._cognitiveStateShadow;
		expect(state.root_compile_count).toBe(1);
		expect(state.packets[0]?.diagnostics.provider_receives).toBe("native");
		expect(state.economics.events[0]?.attributes["cognitive_state.measured_tokens_avoided"] ?? state.economics.events[0]?.context.measured_tokens_avoided).toBe(0);
	});

	test("tool_result creates receipt without modifying return", async () => {
		const pi = mockPi();
		cognitiveStateShadowExtension(pi as never);
		const toolHandlers = pi._handlers.get("tool_result") ?? [];
		const ret = await toolHandlers[0]!({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "abc",
			isError: false,
			content: "PASS 3/3\nexit code: 0",
		});
		expect(ret).toBeUndefined();
		const state = (pi as unknown as { _cognitiveStateShadow: ReturnType<typeof createShadowCompilerState> })
			._cognitiveStateShadow;
		expect(state.receipts.length).toBe(1);
		expect(state.receipts[0]!.artifact_handle.startsWith("rlm://h/")).toBe(true);
	});
});
