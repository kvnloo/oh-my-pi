/**
 * Behavioral coverage for the pii-redact example extension.
 * Proves error-result scrubbing, multimodal block order, configured PAW failure masking and zero-dependency regex
 * fallback, schema property-name scope, opaque signed/encrypted replay,
 * provider metadata/image preservation, and runner timeout limits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	ExtensionRunner,
	testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import * as execUtils from "@oh-my-pi/pi-coding-agent/exec/exec";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import piiRedactExtension, { buildPawArgs, redactText, redactTextLeaves, regexRedact } from "../examples/extensions/pii-redact";

const EXAMPLE_PATH = path.resolve(import.meta.dir, "../examples/extensions/pii-redact.ts");
const PLACEHOLDER = "[PII]";

describe("pii-redact example helpers", () => {
	it("buildPawArgs puts --placeholder before the redact subcommand", () => {
		expect(buildPawArgs("hi", PLACEHOLDER)).toEqual(["--placeholder", PLACEHOLDER, "redact", "--text", "hi"]);
	});

	it("regexRedact scrubs email/phone/ssn", () => {
		const input = "mail a@b.co phone 555-123-4567 ssn 123-45-6789";
		expect(regexRedact(input, PLACEHOLDER)).toBe(`mail ${PLACEHOLDER} phone ${PLACEHOLDER} ssn ${PLACEHOLDER}`);
	});

	it("treats replacement tokens in configured placeholders literally", () => {
		for (const placeholder of ["$&", "$`", "$'", "$$", "[PII $&]"]) {
			expect(regexRedact("a@b.co | 555-123-4567 | 123-45-6789", placeholder)).toBe(
				`${placeholder} | ${placeholder} | ${placeholder}`,
			);
		}
	});

	it("shared async traversal preserves multimodal block order", async () => {
		const content = [
			{ type: "text", text: "before a@b.co" },
			{ type: "image", url: "img://1" },
			{ type: "text", text: "after 555-123-4567" },
		];
		const mapped = (await redactTextLeaves({} as ExtensionAPI, content, PLACEHOLDER)) as Array<Record<string, unknown>>;
		expect(mapped).toEqual([
			{ type: "text", text: `before ${PLACEHOLDER}` },
			{ type: "image", url: "img://1" },
			{ type: "text", text: `after ${PLACEHOLDER}` },
		]);
	});

	it("async traversal walks provider request objects", async () => {
		const payload = {
			model: "gpt",
			input: [{ role: "user", content: "reach me at secret@example.com" }],
			tools: [{ name: "bash", arguments: { cmd: "echo 123-45-6789" } }],
		};
		expect(await redactTextLeaves({} as ExtensionAPI, payload, PLACEHOLDER)).toEqual({
			model: "gpt",
			input: [{ role: "user", content: `reach me at ${PLACEHOLDER}` }],
			tools: [{ name: "bash", arguments: { cmd: `echo ${PLACEHOLDER}` } }],
		});
	});

	it("preserves binary and non-plain provider values without copying them", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const buffer = new ArrayBuffer(4);
		const view = new DataView(buffer);
		const date = new Date(0);
		const payload = { bytes, buffer, view, date, nested: [{ text: "a@b.co" }] };
		const redacted = (await redactTextLeaves({} as ExtensionAPI, payload, PLACEHOLDER)) as typeof payload;
		expect(redacted.bytes).toBe(bytes);
		expect(redacted.buffer).toBe(buffer);
		expect(redacted.view).toBe(view);
		expect(redacted.date).toBe(date);
		expect(redacted.nested).toEqual([{ text: PLACEHOLDER }]);
		expect(payload.nested).toEqual([{ text: "a@b.co" }]);
	});

	it("does not return plaintext on repeated references or cycles", async () => {
		const shared = { email: "secret@example.com", note: "555-123-4567" };
		const original: Record<string, unknown> = { first: shared, second: shared };
		original.self = original;
		const result = (await redactTextLeaves({} as ExtensionAPI, original, PLACEHOLDER)) as {
			first: typeof shared;
			second: typeof shared;
			self: unknown;
		};
		expect(result.first).toEqual({ email: PLACEHOLDER, note: PLACEHOLDER });
		expect(result.second).toBe(result.first);
		expect(result.self).toBe(result);
		expect(result.first).not.toBe(shared);
		expect(shared.email).toBe("secret@example.com");
	});

	it("isolates shared protocol metadata from redactable message references", async () => {
		const shared: Record<string, unknown> = {
			text: "contact secret@example.com",
			nested: { email: "other@example.com" },
		};
		shared.self = shared;
		for (const metadataFirst of [true, false]) {
			// Enumerate both orders: the first visitor must not dictate whether
			// a later reference is scrubbed or kept as protocol metadata.
			const payload = metadataFirst
				? { metadata: shared, messages: [{ role: "user", content: shared }], input: [{ role: "user", content: shared }] }
				: { messages: [{ role: "user", content: shared }], input: [{ role: "user", content: shared }], metadata: shared };
			const result = (await redactTextLeaves(
				{} as ExtensionAPI,
				payload,
				PLACEHOLDER,
				undefined,
				"provider",
			)) as typeof payload;
			expect(result.metadata.text).toBe("contact secret@example.com");
			expect(result.metadata.nested).toEqual({ email: "other@example.com" });
			expect(result.messages[0]!.content.text).toBe(`contact ${PLACEHOLDER}`);
			expect(result.messages[0]!.content.nested).toEqual({ email: PLACEHOLDER });
			expect(result.messages[0]!.content).toBe(result.input[0]!.content);
			expect(result.messages[0]!.content).not.toBe(result.metadata);
			expect(result.metadata.self).toBe(result.metadata);
			expect(result.messages[0]!.content.self).toBe(result.messages[0]!.content);
		}
		expect(shared.text).toBe("contact secret@example.com");
	});

	it("keeps sparse arrays sparse and provider binary data unchanged", async () => {
		const sparse = new Array(3);
		sparse[1] = { text: "a@b.co" };
		const bytes = new Uint8Array([4, 7]);
		const result = (await redactTextLeaves({} as ExtensionAPI, { sparse, bytes }, PLACEHOLDER)) as {
			sparse: typeof sparse;
			bytes: Uint8Array;
		};
		expect(result.sparse).toHaveLength(3);
		expect(0 in result.sparse).toBe(false);
		expect(2 in result.sparse).toBe(false);
		expect(result.sparse[1]).toEqual({ text: PLACEHOLDER });
		expect(result.bytes).toBe(bytes);
	});

	it("continues walking null-prototype JSON records", async () => {
		const record = Object.assign(Object.create(null), { email: "a@b.co" });
		expect(await redactTextLeaves({} as ExtensionAPI, { record }, PLACEHOLDER)).toEqual({ record: { email: PLACEHOLDER } });
	});

	it("scrubs regex-identifiable PII even when PAW reports success but misses it", async () => {
		const previous = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "paw-pii";
		const pi = {
			exec: async () => ({
				code: 0,
				stdout: "name [PII] email a@b.co ssn 123-45-6789\n",
				stderr: "",
				killed: false,
			}),
		} as unknown as ExtensionAPI;
		try {
			expect(await redactText(pi, "name Diana Smith email a@b.co ssn 123-45-6789", PLACEHOLDER)).toBe(
				"name [PII] email [PII] ssn [PII]",
			);
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});
	it("masks NER-only PII if configured PAW fails to spawn", async () => {
		const previous = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "missing-paw-binary-that-does-not-exist";
		const warn = vi.fn();
		const pi = {
			exec: async () => {
				throw new Error("spawn ENOENT");
			},
			logger: { warn },
		} as unknown as ExtensionAPI;
		try {
			const out = await redactText(pi, "Ada Lovelace wrote to a@b.co", PLACEHOLDER);
			expect(out).toBe(PLACEHOLDER);
			expect(warn).toHaveBeenCalled();
			const first = warn.mock.calls[0]?.[1];
			expect(first).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});

	it("masks a configured detector success with no usable redaction output", async () => {
		const old = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "paw-pii";
		try {
			const pi = { exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }) } as unknown as ExtensionAPI;
			expect(await redactText(pi, "Ada Lovelace", PLACEHOLDER)).toBe(PLACEHOLDER);
		} finally {
			if (old === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = old;
		}
	});

	it("masks PII after nonzero detector exit without logging stderr", async () => {
		const previous = process.env.PAW_PII_CMD;
		process.env.PAW_PII_CMD = "paw-pii";
		const warn = vi.fn();
		const pi = {
			exec: async () => ({
				code: 2,
				stdout: "",
				stderr: "ECHOED_SECRET a@b.co",
				killed: false,
			}),
			logger: { warn },
		} as unknown as ExtensionAPI;
		try {
			const out = await redactText(pi, "Ada Lovelace SSN 123-45-6789", PLACEHOLDER);
			expect(out).toBe(PLACEHOLDER);
			expect(JSON.stringify(warn.mock.calls)).not.toContain("ECHOED_SECRET");
			expect(JSON.stringify(warn.mock.calls)).not.toContain("a@b.co");
			expect(warn.mock.calls[0]?.[1]).toEqual({ code: 2, killed: false });
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});
});

describe("pii-redact example extension events", () => {
	let tempDir: TempDir;
	let oldPawCommand: string | undefined;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		oldPawCommand = process.env.PAW_PII_CMD;
		delete process.env.PAW_PII_CMD;
	});

	afterEach(() => {
		if (oldPawCommand === undefined) delete process.env.PAW_PII_CMD;
		else process.env.PAW_PII_CMD = oldPawCommand;
		vi.restoreAllMocks();
		testSetExtensionHandlerTimeoutMs(30_000);
		authStorage?.close();
		tempDir?.removeSync();
		delete process.env.PAW_PII_DISABLE;
	});

	async function loadExampleRunner() {
		tempDir = TempDir.createSync("@pii-redact-ex-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const extensionsDir = path.join(tempDir.path(), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const dest = path.join(extensionsDir, "pii-redact.ts");
		fs.copyFileSync(EXAMPLE_PATH, dest);
		const result = await loadExtensions([dest], tempDir.path());
		expect(result.errors).toEqual([]);
		const sessionManager = SessionManager.inMemory();
		return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
	}


	function makeReplayFixtures() {
		const nativeThinking = {
			type: "thinking", thinking: "native signed Ada Lovelace", thinkingSignature: "native sig Ada Lovelace",
		};
		const nativeText = {
			type: "text", text: "native signed text Ada Lovelace", textSignature: '{"v":1,"id":"text Ada Lovelace"}',
		};
		const nativeRedacted = { type: "redactedThinking", data: "native redacted Ada Lovelace bytes" };
		const anthropicThinking = {
			type: "thinking", thinking: "anthropic signed Ada Lovelace", signature: "anthropic sig Ada Lovelace",
		};
		const anthropicRedacted = { type: "redacted_thinking", data: "anthropic redacted Ada Lovelace bytes" };
		const reasoning = {
			type: "reasoning", encrypted_content: "responses encrypted Ada Lovelace bytes",
			summary: [{ type: "summary_text", text: "Ada Lovelace" }],
		};
		const nativeMessages = [{ role: "assistant", content: [
			nativeThinking, nativeText, nativeRedacted,
			{ type: "text", text: "Ada Lovelace" },
			{ type: "text", text: "later Ada Lovelace" },
		], timestamp: 1 } as never];
		const provider = {
			messages: [{ role: "assistant", content: [
				anthropicThinking, anthropicRedacted,
				{ type: "text", text: "Ada Lovelace" },
				{ type: "text", text: "later Ada Lovelace" },
			] }],
			input: [reasoning, { type: "message", role: "user", content: [{ type: "input_text", text: "Ada Lovelace" }] }],
		};
		return { nativeThinking, nativeText, nativeRedacted, anthropicThinking, anthropicRedacted, reasoning, nativeMessages, provider };
	}

	async function assertReplayProtection(runner: ExtensionRunner, inspected: string[]) {
		const f = makeReplayFixtures();
		const context = await runner.emitContext(f.nativeMessages);
		const blocks = (context[0] as { content: unknown[] }).content;
		expect(blocks[0]).toBe(f.nativeThinking);
		expect(blocks[1]).toBe(f.nativeText);
		expect(blocks[2]).toBe(f.nativeRedacted);
		expect(blocks[3]).toEqual({ type: "text", text: PLACEHOLDER });
		expect(blocks[4]).toEqual({ type: "text", text: PLACEHOLDER });

		const result = (await runner.emitBeforeProviderRequest(f.provider)) as typeof f.provider;
		expect(result.messages[0]?.content[0]).toBe(f.anthropicThinking);
		expect(result.messages[0]?.content[1]).toBe(f.anthropicRedacted);
		expect(result.messages[0]?.content[2]).toEqual({ type: "text", text: PLACEHOLDER });
		expect(result.messages[0]?.content[3]).toEqual({ type: "text", text: PLACEHOLDER });
		expect(result.input[0]).toMatchObject({
			type: "reasoning", encrypted_content: f.reasoning.encrypted_content,
			summary: [{ type: "summary_text", text: PLACEHOLDER }],
		});
		expect(result.input[1]).toMatchObject({
			type: "message", role: "user", content: [{ type: "input_text", text: PLACEHOLDER }],
		});
		for (const opaque of [
			f.nativeThinking.thinking, f.nativeThinking.thinkingSignature,
			f.nativeText.text, f.nativeText.textSignature, f.nativeRedacted.data,
			f.anthropicThinking.thinking, f.anthropicThinking.signature,
			f.anthropicRedacted.data, f.reasoning.encrypted_content,
		]) {
			expect(inspected).not.toContain(opaque);
		}
		expect(inspected).toContain("Ada Lovelace");
		expect(f.nativeThinking.thinking).toBe("native signed Ada Lovelace");
		expect(f.reasoning.encrypted_content).toBe("responses encrypted Ada Lovelace bytes");
	}

	function makeSchemaPayload() {
		return {
			messages: [{ role: "user", content: "Ada Lovelace" }],
			tools: [{ type: "function", name: "lookup", description: "Ada Lovelace", parameters: {
				type: "object",
				description: "Ada Lovelace",
				examples: ["Ada Lovelace"],
				properties: {
					description: {
						type: "string", enum: ["Ada Lovelace"], default: "Ada Lovelace",
						description: "Ada Lovelace",
					},
					examples: {
						type: "array", items: { type: "string" },
						examples: ["Ada Lovelace"], description: "Ada Lovelace",
					},
				},
				patternProperties: {
					description: { type: "string", enum: ["Ada Lovelace"], description: "Ada Lovelace" },
					examples: { type: "string", default: "Ada Lovelace", description: "Ada Lovelace" },
				},
				$defs: {
					examples: {
						type: "object", required: ["description"], description: "Ada Lovelace",
						properties: { description: {
							type: "string", default: "Ada Lovelace", description: "Ada Lovelace",
						} },
					},
				},
				additionalProperties: {
					type: "string", enum: ["Ada Lovelace"], description: "Ada Lovelace",
				},
				required: ["description"],
				default: { description: "Ada Lovelace" },
			} }],
			toolCalls: [{ arguments: { description: "Ada Lovelace details", details: { examples: "Ada Lovelace details" } } }],
		};
	}

	async function assertSchemaProtection(runner: ExtensionRunner) {
		const payload = makeSchemaPayload();
		const result = (await runner.emitBeforeProviderRequest(payload)) as typeof payload;
		const schema = result.tools[0]!.parameters;
		expect(result.messages[0]?.content).toBe(PLACEHOLDER);
		expect(result.tools[0]?.description).toBe(PLACEHOLDER);
		expect(schema.type).toBe("object");
		expect(schema.description).toBe(PLACEHOLDER);
		expect(schema.examples).toEqual([PLACEHOLDER]);
		expect(schema.properties.description).toEqual({
			type: "string", enum: ["Ada Lovelace"], default: "Ada Lovelace",
			description: PLACEHOLDER,
		});
		expect(schema.properties.examples).toEqual({
			type: "array", items: { type: "string" },
			examples: [PLACEHOLDER], description: PLACEHOLDER,
		});
		expect(schema.patternProperties).toEqual({
			description: { type: "string", enum: ["Ada Lovelace"], description: PLACEHOLDER },
			examples: { type: "string", default: "Ada Lovelace", description: PLACEHOLDER },
		});
		expect(schema.$defs.examples).toEqual({
			type: "object", required: ["description"], description: PLACEHOLDER,
			properties: { description: { type: "string", default: "Ada Lovelace", description: PLACEHOLDER } },
		});
		expect(schema.additionalProperties).toEqual({
			type: "string", enum: ["Ada Lovelace"], description: PLACEHOLDER,
		});
		expect(schema.required).toEqual(["description"]);
		expect(schema.default).toEqual({ description: "Ada Lovelace" });
		expect(result.toolCalls[0]?.arguments).toEqual({
			description: PLACEHOLDER, details: { examples: PLACEHOLDER },
		});
		expect(payload.tools[0]?.parameters.properties.description.type).toBe("string");
		expect(payload.tools[0]?.parameters.properties.examples.examples).toEqual(["Ada Lovelace"]);

		const tool = await runner.emitToolResult({
			type: "tool_result", toolName: "lookup", toolCallId: "schema-redaction",
			input: {}, content: [{ type: "text", text: "Ada Lovelace" }],
			details: { description: "Ada Lovelace details", examples: ["Ada Lovelace details"] },
			isError: false,
		});
		expect(tool?.content).toEqual([{ type: "text", text: PLACEHOLDER }]);
		expect(tool?.details).toEqual({ description: PLACEHOLDER, examples: [PLACEHOLDER] });
	}

	it("scrubs failed tool_result content", async () => {
		const runner = await loadExampleRunner();
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "c1",
			input: { command: "cat secrets" },
			content: [{ type: "text", text: "Permission denied for a@b.co" }],
			details: undefined,
			isError: true,
		});
		expect(replaced?.content).toEqual([{ type: "text", text: `Permission denied for ${PLACEHOLDER}` }]);
	});

	it("redacts persisted Ask tool_result details without corrupting binary payloads", async () => {
		const runner = await loadExampleRunner();
		const bytes = new Uint8Array([1, 2, 3]);
		const details = {
			results: [{ customInput: "email a@b.co", note: "call 555-123-4567" }],
			bytes,
		};
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "ask",
			toolCallId: "ask-details-1",
			input: {},
			content: [{ type: "text", text: "response a@b.co" }],
			details,
			isError: false,
		});
		const redactedDetails = replaced?.details as typeof details;
		expect(replaced?.content).toEqual([{ type: "text", text: "response [PII]" }]);
		expect(redactedDetails.results).toEqual([{ customInput: "email [PII]", note: "call [PII]" }]);
		expect(redactedDetails.bytes).toBe(bytes);
		expect(details.results[0]?.customInput).toBe("email a@b.co");
	});

	it("keeps text/image/text order on context rewrite", async () => {
		const runner = await loadExampleRunner();
		const messages = await runner.emitContext([
			{
				role: "user",
				content: [
					{ type: "text", text: "see a@b.co" },
					{ type: "image", mimeType: "image/png", data: "abc" },
					{ type: "text", text: "then 555-123-4567" },
				],
				timestamp: Date.now(),
			} as never,
		]);
		const content = (messages[0] as { content: unknown[] }).content;
		expect(content[0]).toEqual({ type: "text", text: `see ${PLACEHOLDER}` });
		expect(content[1]).toMatchObject({ type: "image" });
		expect(content[2]).toEqual({ type: "text", text: `then ${PLACEHOLDER}` });
	});

	it("redacts structured before_provider_request payloads", async () => {
		const runner = await loadExampleRunner();
		const payload = await runner.emitBeforeProviderRequest({
			messages: [{ role: "user", content: "call secret@example.com" }],
			system: "never leak 123-45-6789",
		});
		expect(payload).toEqual({
			messages: [{ role: "user", content: `call ${PLACEHOLDER}` }],
			system: `never leak ${PLACEHOLDER}`,
		});
	});

	it("preserves provider binary fields through the registered request handler", async () => {
		const runner = await loadExampleRunner();
		const bytes = new Uint8Array([1, 2, 3]);
		const payload = (await runner.emitBeforeProviderRequest({
			conversationState: { rootPromptMessagesJson: bytes },
			system: "contact a@b.co",
		})) as { conversationState: { rootPromptMessagesJson: Uint8Array }; system: string };
		expect(payload.conversationState.rootPromptMessagesJson).toBe(bytes);
		expect(payload.system).toBe(`contact ${PLACEHOLDER}`);
	});

	it("applies configured NER to structured-only provider fields", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const calls: string[] = [];
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args, _cwd, options) => {
			const input = args[args.length - 1] ?? "";
			calls.push(input);
			expect(options?.signal).toBeDefined();
			return { code: 0, stdout: input.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		const bytes = new Uint8Array([12, 34]);
		const payload = {
			system: "Ada Lovelace",
			tools: [{ description: "Ask Ada Lovelace", parameters: { properties: { note: { description: "Ada Lovelace" } } } }],
			toolCalls: [{ arguments: { recipient: "Ada Lovelace" } }],
			native: { bytes },
		};
		const transformed = (await runner.emitBeforeProviderRequest(payload)) as typeof payload;
		expect(transformed.system).toBe(PLACEHOLDER);
		expect(transformed.tools[0]?.description).toBe("Ask [PII]");
		expect(transformed.tools[0]?.parameters.properties.note.description).toBe(PLACEHOLDER);
		expect(transformed.toolCalls[0]?.arguments.recipient).toBe(PLACEHOLDER);
		expect(transformed.native.bytes).toBe(bytes);
		expect(calls).toContain("Ada Lovelace");
		expect(payload.system).toBe("Ada Lovelace");
	});

	it("retains Responses protocol, matching call IDs, image references and schema constraints on killed NER", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const inspected: string[] = [];
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			inspected.push(args[args.length - 1] ?? "");
			return { code: 1, stdout: "", stderr: "hidden", killed: true };
		});
		const runner = await loadExampleRunner();
		const callId = "call_Ada Lovelace_meta";
		const imageUrl = "data:image/png;base64,Ada Lovelace_opaque";
		const fileId = "file_Ada Lovelace_opaque";
		const rawArgs = JSON.stringify({
			recipient: "Ada Lovelace",
			id: "Ada Lovelace",
			image_url: { url: imageUrl },
		});
		const original = {
			model: "gpt-Ada Lovelace-model",
			input: [
				{
					role: "user",
					content: [
						{ type: "input_text", text: "Ada Lovelace" },
						{ type: "input_image", image_url: imageUrl, file_id: fileId },
					],
				},
				{
					type: "function_call", call_id: callId, name: "lookup_Ada Lovelace",
					arguments: rawArgs, signature: "sig_Ada Lovelace_meta",
				},
				{ type: "function_call_output", call_id: callId, output: "Tell Ada Lovelace" },
			],
			tools: [{
				type: "function", name: "lookup_Ada Lovelace", description: "Ask Ada Lovelace",
				parameters: {
					type: "object",
					properties: {
						recipient: {
							type: "string", enum: ["Ada Lovelace"], default: "Ada Lovelace",
							description: "Ask Ada Lovelace",
						},
					},
					required: ["recipient"],
				},
			}],
		};
		const redacted = (await runner.emitBeforeProviderRequest(original)) as typeof original;
		expect(redacted.model).toBe(original.model);
		expect(redacted.input[0]?.role).toBe("user");
		expect(redacted.input[0]?.content?.[0]).toEqual({ type: "input_text", text: PLACEHOLDER });
		expect(redacted.input[0]?.content?.[1]).toEqual(original.input[0]?.content?.[1]);
		expect(redacted.input[1]?.call_id).toBe(callId);
		expect(redacted.input[2]?.call_id).toBe(callId);
		expect(redacted.input[1]?.name).toBe("lookup_Ada Lovelace");
		expect(redacted.input[1]?.signature).toBe("sig_Ada Lovelace_meta");
		const scrubbedArgs = JSON.parse(redacted.input[1]!.arguments!);
		expect(scrubbedArgs).toEqual({
			recipient: PLACEHOLDER, id: PLACEHOLDER, image_url: { url: imageUrl },
		});
		expect(redacted.input[2]?.output).toBe(PLACEHOLDER);
		expect(redacted.tools[0]?.type).toBe("function");
		expect(redacted.tools[0]?.name).toBe("lookup_Ada Lovelace");
		expect(redacted.tools[0]?.description).toBe(PLACEHOLDER);
		expect(redacted.tools[0]?.parameters).toEqual({
			type: "object",
			properties: {
				recipient: {
					type: "string", enum: ["Ada Lovelace"], default: "Ada Lovelace",
					description: PLACEHOLDER,
				},
			},
			required: ["recipient"],
		});
		expect(inspected).not.toContain(imageUrl);
		expect(inspected).not.toContain(fileId);
		expect(inspected).not.toContain(callId);
		expect(inspected).not.toContain("sig_Ada Lovelace_meta");
		expect(inspected).not.toContain("gpt-Ada Lovelace-model");
		expect(JSON.parse(original.input[1]!.arguments!).recipient).toBe("Ada Lovelace");
	});

	it("protects Anthropic source, Google inlineData and Completions image_url through registered NER", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const inspected: string[] = [];
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			const input = args[args.length - 1] ?? "";
			inspected.push(input);
			return { code: 0, stdout: input.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		const anthropicSource = { type: "base64", media_type: "image/png", data: "anthropic_Ada Lovelace_opaque" };
		const toolUseId = "toolu_Ada Lovelace_ref";
		const anthropic = {
			messages: [
				{ role: "user", content: [
					{ type: "text", text: "Ada Lovelace" },
					{ type: "image", source: anthropicSource },
					{ type: "thinking", thinking: "signed Anthropic Ada Lovelace thinking", signature: "sig_Ada Lovelace_opaque" },
				] },
				{ role: "assistant", content: [{
					type: "tool_use", id: toolUseId, name: "lookup_Ada Lovelace",
					input: { id: "Ada Lovelace", recipient: "Ada Lovelace" },
				}] },
				{ role: "user", content: [{
					type: "tool_result", tool_use_id: toolUseId, content: "Ada Lovelace",
				}] },
			],
		};
		const a = (await runner.emitBeforeProviderRequest(anthropic)) as {
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		expect(a.messages[0]?.content[0]?.text).toBe(PLACEHOLDER);
		expect(a.messages[0]?.content[1]?.source).toBe(anthropicSource);
		// Anthropic validates the signature against these exact thinking bytes.
		// Do not scrub the text and replay its original signature.
		expect(a.messages[0]?.content[2]).toBe(anthropic.messages[0]?.content[2]);
		expect(a.messages[0]?.content[2]?.thinking).toBe("signed Anthropic Ada Lovelace thinking");
		expect(a.messages[0]?.content[2]?.signature).toBe("sig_Ada Lovelace_opaque");
		expect(a.messages[1]?.content[0]?.id).toBe(toolUseId);
		expect(a.messages[1]?.content[0]?.name).toBe("lookup_Ada Lovelace");
		expect(a.messages[1]?.content[0]?.input).toEqual({ id: PLACEHOLDER, recipient: PLACEHOLDER });
		expect(a.messages[2]?.content[0]?.tool_use_id).toBe(toolUseId);
		expect(a.messages[2]?.content[0]?.content).toBe(PLACEHOLDER);

		const inlineData = { mimeType: "image/png", data: "google_Ada Lovelace_opaque" };
		const google = { contents: [{ role: "user", parts: [
			{ text: "Ada Lovelace" },
			{ inlineData },
			{ functionResponse: {
				name: "lookup_Ada Lovelace",
				response: { id: "Ada Lovelace", type: "Ada Lovelace" },
			} },
		] }] };
		const g = (await runner.emitBeforeProviderRequest(google)) as {
			contents: Array<{ parts: Array<Record<string, unknown>> }>;
		};
		expect(g.contents[0]?.parts[0]?.text).toBe(PLACEHOLDER);
		expect(g.contents[0]?.parts[1]?.inlineData).toBe(inlineData);
		expect(g.contents[0]?.parts[2]?.functionResponse).toEqual({
			name: "lookup_Ada Lovelace", response: { id: PLACEHOLDER, type: PLACEHOLDER },
		});

		const imageUrl = { url: "data:image/jpeg;base64,completion_Ada Lovelace_opaque" };
		const completions = {
			model: "model_Ada Lovelace",
			messages: [{ role: "user", content: [
				{ type: "text", text: "Ada Lovelace" },
				{ type: "image_url", image_url: imageUrl },
			] }],
		};
		const c = (await runner.emitBeforeProviderRequest(completions)) as {
			model: string;
			messages: Array<{ content: Array<Record<string, unknown>> }>;
		};
		expect(c.model).toBe(completions.model);
		expect(c.messages[0]?.content[0]?.text).toBe(PLACEHOLDER);
		expect(c.messages[0]?.content[1]?.image_url).toBe(imageUrl);
		for (const opaque of [
			anthropicSource.data, "sig_Ada Lovelace_opaque", toolUseId, inlineData.data, imageUrl.url,
			"model_Ada Lovelace", "signed Anthropic Ada Lovelace thinking",
		]) {
			expect(inspected).not.toContain(opaque);
		}
		expect(inspected).toContain("Ada Lovelace");
	});


	it("keeps native, Anthropic and Responses replay bytes intact under killed detectors", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const inspected: string[] = [];
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			inspected.push(args[args.length - 1] ?? "");
			return { code: 1, stdout: "", stderr: "", killed: true };
		});
		const runner = await loadExampleRunner();
		await assertReplayProtection(runner, inspected);
	});

	it("keeps signed, encrypted and redacted replay intact when the detector work budget expires", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const inspected: string[] = [];
		const realNow = performance.now.bind(performance);
		let offset = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
		let calls = 0;
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			calls++;
			const text = args[args.length - 1] ?? "";
			inspected.push(text);
			offset += 25_000;
			return { code: 0, stdout: text.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		await assertReplayProtection(runner, inspected);
		expect(calls).toBe(2); // One detector call per event; later distinct text must use the budget fallback.
	});

	it("keeps schema property and definition names in schema scope after detector kill", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		vi.spyOn(execUtils, "execCommand").mockImplementation(async () => ({
			code: 1, stdout: "", stderr: "", killed: true,
		}));
		const runner = await loadExampleRunner();
		await assertSchemaProtection(runner);
	});

	it("keeps nested schemas valid after the detector budget expires", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const realNow = performance.now.bind(performance);
		let offset = 0;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + offset);
		let calls = 0;
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			calls++;
			const text = args[args.length - 1] ?? "";
			offset += 25_000;
			return { code: 0, stdout: text.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		await assertSchemaProtection(runner);
		expect(calls).toBe(2); // Provider event and tool-result event each reach their internal budget.
	});

	it("treats nested result detail id/type fields as private data, not provider metadata", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		vi.spyOn(execUtils, "execCommand").mockImplementation(async () => ({
			code: 1, stdout: "", stderr: "", killed: true,
		}));
		const runner = await loadExampleRunner();
		const details = { results: [{ id: "Ada Lovelace", type: "Ada Lovelace", note: "Ada Lovelace" }] };
		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "ask",
			toolCallId: "call-Ada Lovelace-metadata",
			input: {},
			content: [{ type: "text", text: "Ada Lovelace" }],
			details,
			isError: false,
		});
		expect(result?.content).toEqual([{ type: "text", text: PLACEHOLDER }]);
		expect(result?.details).toEqual({ results: [{ id: PLACEHOLDER, type: PLACEHOLDER, note: PLACEHOLDER }] });
		expect(details.results[0]?.id).toBe("Ada Lovelace");
	});

	it("returns only scrubbed content and intact protocol fields when internal detector budget expires", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const runner = await loadExampleRunner();
		const realNow = performance.now.bind(performance);
		let expireBudget = false;
		vi.spyOn(performance, "now").mockImplementation(() => realNow() + (expireBudget ? 25_000 : 0));
		let calls = 0;
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args) => {
			calls++;
			expireBudget = true;
			const input = args[args.length - 1] ?? "";
			return { code: 0, stdout: input.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const original = {
			model: "model_Ada Lovelace_meta",
			input: [{ role: "user", content: Array.from({ length: 18 }, (_, i) => ({
				type: "input_text", text: "block " + i + " Ada Lovelace",
			})) }],
		};
		const result = (await runner.emitBeforeProviderRequest(original)) as typeof original;
		expect(result.model).toBe(original.model);
		expect(result.input[0]?.role).toBe("user");
		expect(result.input[0]?.content[0]?.text).toBe("block 0 [PII]");
		expect(result.input[0]?.content.slice(1).every(part => part.text === PLACEHOLDER)).toBe(true);
		expect(calls).toBe(1);
		expect(original.input[0]?.content[1]?.text).toContain("Ada Lovelace");
	});

	it("applies configured NER to persisted details and text blocks", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args, _cwd, options) => {
			expect(options?.signal).toBeDefined();
			const input = args[args.length - 1] ?? "";
			return { code: 0, stdout: input.replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		const image = { type: "image" as const, mimeType: "image/png" as const, data: "binary_data" };
		const replaced = await runner.emitToolResult({
			type: "tool_result",
			toolName: "ask",
			toolCallId: "ask-ner",
			input: {},
			content: [
				{ type: "text", text: "Ada Lovelace" },
				image,
				{ type: "text", text: "For Ada Lovelace" },
			],
			details: { results: [{ customInput: "Ada Lovelace", note: "Hi Ada Lovelace" }] },
			isError: true,
		});
		expect(replaced?.content).toEqual([
			{ type: "text", text: PLACEHOLDER },
			image,
			{ type: "text", text: "For [PII]" },
		]);
		expect(replaced?.details).toEqual({ results: [{ customInput: PLACEHOLDER, note: "Hi [PII]" }] });
		const context = await runner.emitContext([
			{ role: "user", content: [{ type: "text", text: "Ada Lovelace" }, image], timestamp: 1 } as never,
		]);
		expect((context[0] as { content: Array<{ text?: string; data?: string }> }).content[0]?.text).toBe(PLACEHOLDER);
		expect((context[0] as { content: Array<{ text?: string; data?: string }> }).content[1]?.data).toBe("binary_data");
	});

	it("bounds many PAW calls concurrently without rearranging the transcript", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		let inflight = 0;
		let peak = 0;
		let calls = 0;
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, args, _cwd, options) => {
			expect(options?.signal).toBeDefined();
			inflight++;
			peak = Math.max(peak, inflight);
			calls++;
			await Bun.sleep(10);
			inflight--;
			return { code: 0, stdout: (args[args.length - 1] ?? "").replaceAll("Ada Lovelace", PLACEHOLDER), stderr: "", killed: false };
		});
		const runner = await loadExampleRunner();
		const blocks = Array.from({ length: 72 }, (_, index) => ({
			type: "text" as const,
			text: "block " + index + ": Ada Lovelace",
		}));
		const original = [{ role: "user", content: blocks, timestamp: 1 } as never];
		const messages = await runner.emitContext(original);
		const mapped = (messages[0] as { content: typeof blocks }).content;
		expect(mapped.map(block => block.text)).toEqual(blocks.map(block => block.text.replace("Ada Lovelace", PLACEHOLDER)));
		expect(blocks[71]?.text).toContain("Ada Lovelace");
		expect(calls).toBeGreaterThanOrEqual(72);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(8);
	});

	it("proves runner handler timeout aborts PAW but still forwards original private content", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		const signals: Array<AbortSignal | undefined> = [];
		vi.spyOn(execUtils, "execCommand").mockImplementation(async (_command, _args, _cwd, options) => {
			const signal = options?.signal;
			signals.push(signal);
			const { promise, resolve } = Promise.withResolvers<void>();
			if (signal?.aborted) resolve();
			else signal?.addEventListener("abort", () => resolve(), { once: true });
			await promise;
			return { code: 1, stdout: "", stderr: "", killed: true };
		});
		const runner = await loadExampleRunner();
		testSetExtensionHandlerTimeoutMs(30);
		const original = [{ role: "user", content: Array.from({ length: 40 }, (_, i) => ({ type: "text", text: "Ada Lovelace " + i })), timestamp: 1 } as never];
		const returned = await runner.emitContext(original);
		// Runner timeout wins the race and discards the handler's safe replacement.
		// This is a documented privacy gap, NOT a fail-closed acceptance test.
		expect(returned).toEqual(original);
		expect(JSON.stringify(returned)).toContain("Ada Lovelace");
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.length).toBeLessThanOrEqual(8);
		expect(signals.every(signal => signal?.aborted)).toBe(true);
		signals.length = 0;
		const rawPayload = {
			model: "gpt-Ada Lovelace-metadata",
			messages: [{ role: "user", content: "Ada Lovelace" }],
		};
		const forwarded = await runner.emitBeforeProviderRequest(rawPayload);
		expect(forwarded).toBe(rawPayload);
		expect((forwarded as typeof rawPayload).messages[0]?.content).toBe("Ada Lovelace");
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.every(signal => signal?.aborted)).toBe(true);
	});

	it("masks full persisted text when a configured detector is unavailable", async () => {
		process.env.PAW_PII_CMD = "mock-paw";
		vi.spyOn(execUtils, "execCommand").mockImplementation(async () => {
			throw new Error("process unavailable");
		});
		const runner = await loadExampleRunner();
		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "ask",
			toolCallId: "ask-fallback",
			input: {},
			content: [{ type: "text", text: "Ada Lovelace email a@b.co" }],
			details: { note: "Ada Lovelace SSN 123-45-6789" },
			isError: true,
		});
		expect(result?.content).toEqual([{ type: "text", text: PLACEHOLDER }]);
		expect(result?.details).toEqual({ note: PLACEHOLDER });
	});

	it("registers via default export factory", () => {
		const commands: string[] = [];
		const handlers: string[] = [];
		const pi = {
			setLabel: () => {},
			registerCommand: (name: string) => {
				commands.push(name);
			},
			on: (event: string) => {
				handlers.push(event);
			},
		} as unknown as ExtensionAPI;
		piiRedactExtension(pi);
		expect(commands).toContain("pii");
		expect(handlers).toEqual(["tool_result", "context", "before_provider_request"]);
	});
});
