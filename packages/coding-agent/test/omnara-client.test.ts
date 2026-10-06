import { describe, expect, it } from "bun:test";

import { SseParser } from "../src/experiments/omnara-client";

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
