/**
 * Behavioral coverage for the pii-redact example extension.
 * Proves error-result scrubbing, multimodal block order, PAW fail-open
 * fallback, and structured provider payload redaction.
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

	it("redactText falls back to regex when PAW exec throws", async () => {
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
			const out = await redactText(pi, "write a@b.co", PLACEHOLDER);
			expect(out).toBe(`write ${PLACEHOLDER}`);
			expect(warn).toHaveBeenCalled();
			const first = warn.mock.calls[0]?.[1];
			expect(first).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PAW_PII_CMD;
			else process.env.PAW_PII_CMD = previous;
		}
	});

	it("redactText falls back without logging detector stderr", async () => {
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
			const out = await redactText(pi, "ssn 123-45-6789", PLACEHOLDER);
			expect(out).toBe(`ssn ${PLACEHOLDER}`);
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

	it("cancels outstanding detector processes at the runner handler deadline", async () => {
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
		await runner.emitContext(original);
		expect(signals.length).toBeGreaterThan(0);
		expect(signals.length).toBeLessThanOrEqual(8);
		expect(signals.every(signal => signal?.aborted)).toBe(true);
	});

	it("uses regex fallback on detector failures without a raw subprocess log", async () => {
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
			content: [{ type: "text", text: "email a@b.co" }],
			details: { note: "SSN 123-45-6789" },
			isError: true,
		});
		expect(result?.content).toEqual([{ type: "text", text: "email [PII]" }]);
		expect(result?.details).toEqual({ note: "SSN [PII]" });
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
