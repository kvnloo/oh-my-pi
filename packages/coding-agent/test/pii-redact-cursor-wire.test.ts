import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	ConversationStateStructureSchema,
	type AgentRunRequest,
} from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import piiRedactExtension from "../examples/extensions/pii-redact";

async function redactPayload(payload: unknown): Promise<unknown> {
	let handler: ExtensionHandler<BeforeProviderRequestEvent, unknown> | undefined;
	const previous = {
		disable: process.env.PAW_PII_DISABLE,
		placeholder: process.env.PAW_PII_PLACEHOLDER,
	};
	try {
		delete process.env.PAW_PII_DISABLE;
		delete process.env.PAW_PII_PLACEHOLDER;
		piiRedactExtension({
			setLabel: () => {},
			registerCommand: () => {},
			on: (event: string, callback: ExtensionHandler<BeforeProviderRequestEvent, unknown>) => {
				if (event === "before_provider_request") handler = callback;
			},
		} as unknown as ExtensionAPI);
	} finally {
		if (previous.disable === undefined) delete process.env.PAW_PII_DISABLE;
		else process.env.PAW_PII_DISABLE = previous.disable;
		if (previous.placeholder === undefined) delete process.env.PAW_PII_PLACEHOLDER;
		else process.env.PAW_PII_PLACEHOLDER = previous.placeholder;
	}
	assert.ok(handler);
	return handler({ type: "before_provider_request", payload }, {} as ExtensionContext);
}

describe("pii-redact Cursor wire compatibility", () => {
	it("encodes redacted Cursor requests without corrupting blob IDs or binary subviews", async () => {
		const backing = new Uint8Array([99, 1, 2, 255, 88]);
		const subview = backing.subarray(1, 4);
		const payload = create(AgentRunRequestSchema, {
			conversationState: create(ConversationStateStructureSchema, {
				rootPromptMessagesJson: [new Uint8Array([1, 2, 255]), subview],
				fileStates: { fixture: subview },
			}),
			customSystemPrompt: "Contact synthetic@example.com",
		});
		const original = structuredClone(payload);
		const redacted = (await redactPayload(payload)) as AgentRunRequest;
		const message = create(AgentClientMessageSchema, {
			message: { case: "runRequest", value: redacted },
		});
		const decoded = fromBinary(AgentClientMessageSchema, toBinary(AgentClientMessageSchema, message));
		assert.equal(decoded.message.case, "runRequest");
		if (decoded.message.case !== "runRequest") throw new Error("Missing run request");
		assert.equal(decoded.message.value.customSystemPrompt, "Contact [PII]");
		assert.deepEqual(decoded.message.value.conversationState?.rootPromptMessagesJson, [
			new Uint8Array([1, 2, 255]),
			new Uint8Array([1, 2, 255]),
		]);
		assert.deepEqual(decoded.message.value.conversationState?.fileStates.fixture, new Uint8Array([1, 2, 255]));
		assert.deepEqual(structuredClone(payload), original);
		assert.deepEqual(backing, new Uint8Array([99, 1, 2, 255, 88]));
	});

	it("still redacts nested JSON string leaves while preserving scalar controls and opaque bytes", async () => {
		const opaque = new TextEncoder().encode("synthetic@example.com");
		const payload = {
			input: [{ text: "Contact synthetic@example.com", values: [null, false, 7] }],
			tool: { arguments: { text: "SSN 123-45-6789" } },
			opaque,
		};
		const original = structuredClone(payload);
		assert.deepEqual(await redactPayload(payload), {
			input: [{ text: "Contact [PII]", values: [null, false, 7] }],
			tool: { arguments: { text: "SSN [PII]" } },
			opaque: new TextEncoder().encode("synthetic@example.com"),
		});
		assert.deepEqual(payload, original);
	});
});
