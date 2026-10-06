import { afterEach, describe, expect, it } from "bun:test";

import { OmnaraClient, SseParser } from "../src/experiments/omnara-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function client(): OmnaraClient {
	return new OmnaraClient({
		baseUrl: "https://omnara.test/v1",
		token: "token_test",
		orgID: "org_test",
		projectID: "proj_test",
		agentID: "agt_main",
	});
}

describe("Omnara SSE parser", () => {
	it("parses durable and delta frames", () => {
		const parser = new SseParser();
		const frames = parser.push(
			[
				"event: model_output_delta",
				'data: {"event":{"kind":"text_delta","delta":"hello"}}',
				"",
				"id: 7",
				"event: model_output",
				'data: {"event_kind":"model_output","sequence":7}',
				"",
				"",
			].join("\n"),
		);

		expect(frames).toEqual([
			{
				event: "model_output_delta",
				data: '{"event":{"kind":"text_delta","delta":"hello"}}',
			},
			{
				event: "model_output",
				id: "7",
				data: '{"event_kind":"model_output","sequence":7}',
			},
		]);
	});

	it("survives chunk boundaries and heartbeat comments", () => {
		const parser = new SseParser();
		expect(parser.push(": heart")).toEqual([]);
		expect(parser.push("beat\r\n\r\nevent: tool_call_update\r\n")).toEqual([]);
		expect(parser.push('data: {"tool_call_id":"tcl_1","state":"running"}\r\n\r\n')).toEqual([
			{
				event: "tool_call_update",
				data: '{"tool_call_id":"tcl_1","state":"running"}',
			},
		]);
	});

	it("joins multi-line data fields per the SSE contract", () => {
		const parser = new SseParser();
		expect(parser.push("event: message\ndata: first\ndata: second\n\n")).toEqual([
			{ event: "message", data: "first\nsecond" },
		]);
	});
});


describe("Omnara REST contract", () => {
	it("submits input to the selected agent with auth and idempotency", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = (async (input, init) => {
			request = { url: String(input), init };
			return Response.json({ agent_input: { id: "inp_1", state: "queued" } });
		}) as typeof fetch;

		await client().createInput("hello", "omp-key", "steering");

		expect(request?.url).toBe(
			"https://omnara.test/v1/orgs/org_test/projects/proj_test/agents/agt_main/inputs",
		);
		expect(request?.init?.method).toBe("POST");
		const headers = new Headers(request?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer token_test");
		expect(headers.get("Idempotency-Key")).toBe("omp-key");
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			content_blocks: [{ type: "text", text: "hello" }],
			delivery_mode: "steering",
		});
	});

	it("resolves an interaction on the interaction's owning subagent", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = (async (input, init) => {
			request = { url: String(input), init };
			return Response.json({ interaction: { id: "int_1", state: "resolved" } });
		}) as typeof fetch;

		await client().resolveInteraction("agt_child", "int_1", [{ option_indices: [1], text: "note" }]);

		expect(request?.url).toBe(
			"https://omnara.test/v1/orgs/org_test/projects/proj_test/agents/agt_child/interactions/int_1/resolve",
		);
		expect(request?.init?.method).toBe("POST");
		expect(JSON.parse(String(request?.init?.body))).toEqual({
			answers: [{ option_indices: [1], text: "note" }],
		});
	});

	it("cancels the selected remote agent", async () => {
		let request: { url: string; init?: RequestInit } | undefined;
		globalThis.fetch = (async (input, init) => {
			request = { url: String(input), init };
			return Response.json({ cancelled: true });
		}) as typeof fetch;

		await client().cancel();

		expect(request?.url).toBe(
			"https://omnara.test/v1/orgs/org_test/projects/proj_test/agents/agt_main/cancel",
		);
		expect(request?.init?.method).toBe("POST");
	});
});
