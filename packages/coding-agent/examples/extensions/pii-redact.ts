/**
 * PII redaction extension (pattern + lightweight fallback)
 *
 * Demonstrates first-class privacy middleware on the extension event bus:
 *   - tool_result              — scrub tool output (success and error) before it re-enters context
 *   - context                  — rewrite AgentMessage[] before the LLM call
 *   - before_provider_request  — content-aware scrub of provider request text (not protocol metadata)
 *
 * This example ships a small regex fallback so it runs with zero deps.
 * For production NER (names, addresses, multilingual PII) point
 * PAW_PII_CMD at the local ProgramAsWeights CLI from:
 *   https://github.com/kvnloo/pii  (integrations/omp package: omp-paw-pii)
 *
 * Complements built-in secrets.enabled (credentials) — does not replace it.
 * WARNING: if the extension handler itself times out, ExtensionRunner can
 * discard its result and continue with original, unredacted input. Detector
 * kills and the internal work budget fail closed, but runner timeout does not.
 *
 * Usage:
 *   omp -e packages/coding-agent/examples/extensions/pii-redact.ts
 *   # or: omp plugin link /path/to/pii/integrations/omp
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

type ToolResultContent = (TextContent | ImageContent)[];

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/** Keep PAW well under the extension handler timeout (30s). */
const PAW_TIMEOUT_MS = 5_000;
/** Reserve ten seconds for traversal, other handlers, and runner cleanup. */
const PAW_EVENT_BUDGET_MS = 20_000;
/** PAW's CLI accepts one --text; bound parallel single-text calls, not invented batch flags. */
const PAW_MAX_CONCURRENCY = 8;

export function regexRedact(text: string, placeholder: string): string {
	const replacement = () => placeholder;
	return text.replace(EMAIL, replacement).replace(PHONE, replacement).replace(SSN, replacement);
}

/** Build argv for the linked paw-pii CLI (`--placeholder` is a root option). */
export function buildPawArgs(text: string, placeholder: string): string[] {
	return ["--placeholder", placeholder, "redact", "--text", text];
}

type RedactionScope = "data" | "messages" | "provider" | "schema";

interface TextDestination {
	target: object;
	key: string;
}

interface TextTask {
	text: string;
	destinations: TextDestination[];
}

interface PendingObject {
	source: object;
	target: object;
	scope: RedactionScope;
}

/**
 * Only known textual request fields opt into PAW at the provider envelope.
 * Inside messages, text is the default except for protocol metadata.
 * Inside actual tool arguments and result details, *all* ordinary string
 * values are data (even a key named "id", "type" or "model").
 */
const PROVIDER_TEXT_FIELDS = new Set([
	"content", "contents", "description", "input", "instructions", "message", "messages",
	"note", "output", "parts", "prompt", "query", "reasoning", "response", "responses",
	"result", "summary", "system", "systemInstruction", "system_instruction", "text",
	"thought", "toolCalls", "tool_calls",
]);
const DATA_FIELDS = new Set([
	"args", "arguments", "details", "functionArguments", "function_arguments",
	"toolArgs", "toolInput", "tool_args", "tool_input",
]);
const SCHEMA_FIELDS = new Set([
	"input_schema", "json_schema", "parameters", "responseSchema", "response_schema", "schema",
]);
const MESSAGE_METADATA_FIELDS = new Set([
	"api", "callId", "call_id", "detail", "file_id", "finishReason", "finish_reason",
	"format", "id", "item_id", "kind", "media_type", "mimeType", "mime_type", "model",
	"name", "object", "provider", "recipient", "response_id", "role", "signature",
	"status", "thoughtSignature", "toolCallId", "toolName", "toolUseId", "tool_call_id", "tool_name", "tool_use_id",
	"type", "uri", "url", "version",
]);
const IMAGE_METADATA_FIELDS = new Set([
	"data", "detail", "file_id", "format", "media_type", "mimeType", "mime_type", "source", "url",
]);
const CONTENT_BLOCK_TYPES = new Set([
	"image", "image_url", "input_audio", "input_file", "input_image", "input_text",
	"output_audio", "output_text", "redacted_thinking", "text", "thinking",
]);

function childScope(scope: RedactionScope, key: string, parent: object): RedactionScope {
	if (scope === "data") return "data";
	// Schema constraints (including enum/required/default/pattern/type) are
	// protocol, not prose. Descriptions and examples can contain real PII.
	if (scope === "schema") return key === "description" || key === "examples" ? "data" : "schema";
	if (DATA_FIELDS.has(key)) return "data";
	if (SCHEMA_FIELDS.has(key)) return "schema";
	// The same "input" key means a message array at the request root and
	// arbitrary user-supplied tool parameters on Anthropic tool_use blocks.
	if (scope === "messages" && key === "input" && Reflect.get(parent, "type") === "tool_use") return "data";
	// Gemini functionResponse.name is a protocol identifier, but its response
	// object is arbitrary tool data and may contain PII even under "id".
	if (scope === "messages" && key === "response" && "name" in parent) return "data";
	if (scope === "provider") return PROVIDER_TEXT_FIELDS.has(key) ? "messages" : "provider";
	return "messages";
}

function opaqueImageField(source: object, key: string): boolean {
	// All of these are opaque provider image references or encoded bytes.
	// Never pass their values (or nested source/url objects) to an NER CLI.
	if (key === "inlineData" || key === "inline_data" || key === "fileData" || key === "file_data") return true;
	if (key === "image_url" || key === "imageUrl" || key === "b64_json") return true;
	const type = Reflect.get(source, "type");
	const isImage = type === "image" || type === "input_image" || type === "image_url" || type === "input_file";
	if (isImage && IMAGE_METADATA_FIELDS.has(key)) return true;
	const mime = Reflect.get(source, "mimeType") ?? Reflect.get(source, "mime_type") ?? Reflect.get(source, "media_type");
	return key === "data" && typeof mime === "string" && mime.startsWith("image/");
}

/**
 * Graph-preserving content traversal for context, persisted results and request
 * envelopes. Only content strings are sent to PAW. Protocol IDs, schema
 * constraints, signatures and image data/URLs are never rewritten; arbitrary
 * nested tool arguments and details are still fully traversed.
 *
 * At most eight PAW subprocesses per invocation (not globally across
 * concurrent events). The internal 20s budget fails closed for *content*
 * leaves, but the ExtensionRunner's own 30s timeout discards handler results
 * and may return the unredacted original; this example is not a mandatory
 * fail-closed privacy boundary.
 */
export async function redactTextLeaves(
	pi: ExtensionAPI,
	input: unknown,
	placeholder: string,
	signal?: AbortSignal,
	surface: RedactionScope = "data",
): Promise<unknown> {
	const deadline = performance.now() + PAW_EVENT_BUDGET_MS;
	const root: { value?: unknown } = {};
	const seen = new WeakMap<object, object>();
	const queue: PendingObject[] = [];
	const tasks: TextTask[] = [];
	const byText = new Map<string, TextTask>();
	const serializedArguments: Array<{ source: string; parsed: unknown; holder: { value?: unknown }; target: object; key: string }> = [];

	const visit = (value: unknown, target: object, key: string, scope: RedactionScope, typedBlock = false): void => {
		if (typeof value === "string") {
			const structural =
				scope === "provider" || scope === "schema" ||
				(scope === "messages" && MESSAGE_METADATA_FIELDS.has(key)) ||
				(typedBlock && key === "type");
			if (value.length === 0 || structural) {
				Reflect.set(target, key, value);
				return;
			}
			let task = byText.get(value);
			if (!task) {
				task = { text: value, destinations: [] };
				byText.set(value, task);
				tasks.push(task);
			}
			task.destinations.push({ target, key });
			return;
		}
		if (value === null || typeof value !== "object") {
			Reflect.set(target, key, value);
			return;
		}
		const prototype = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
			// Binary buffers, dates, and provider-native objects retain identity.
			Reflect.set(target, key, value);
			return;
		}
		const prior = seen.get(value);
		if (prior) {
			Reflect.set(target, key, prior);
			return;
		}
		const copy: object = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
		seen.set(value, copy);
		Reflect.set(target, key, copy);
		queue.push({ source: value, target: copy, scope });
	};

	// Providers may supply a text or a flat message array directly as payload.
	const rootScope = surface === "provider" && (typeof input === "string" || Array.isArray(input))
		? "messages"
		: surface;
	visit(input, root, "value", rootScope);
	for (let index = 0; index < queue.length; index++) {
		const { source, target, scope } = queue[index]!;
		const type = Reflect.get(source, "type");
		const typedBlock = CONTENT_BLOCK_TYPES.has(type);
		for (const [key, child] of Object.entries(source)) {
			if (opaqueImageField(source, key)) {
				Reflect.set(target, key, child);
				continue;
			}
			// OpenAI/Responses function arguments can be a JSON-encoded string.
			// Traverse the JSON values instead of passing structural quotes,
			// property names and embedded image URLs to the detector. Re-encode
			// only if something actually changed, preserving original formatting.
			if ((key === "arguments" || key === "function_arguments") && typeof child === "string") {
				let parsed: unknown;
				try {
					parsed = JSON.parse(child);
				} catch {
					parsed = undefined;
				}
				if (parsed !== null && typeof parsed === "object") {
					const holder: { value?: unknown } = {};
					visit(parsed, holder, "value", "data");
					serializedArguments.push({ source: child, parsed, holder, target, key });
					continue;
				}
			}
			visit(child, target, key, childScope(scope, key, source), typedBlock);
		}
	}

	const configured = Boolean(process.env.PAW_PII_CMD);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < tasks.length) {
			const task = tasks[cursor++]!;
			const remaining = Math.floor(deadline - performance.now());
			// An exhausted budget or cancelled detector cannot certify NER-only
			// names, so redact the whole content leaf (never protocol metadata).
			const redacted =
				signal?.aborted || (configured && remaining < 100)
					? placeholder
					: await redactText(pi, task.text, placeholder, signal, Math.min(PAW_TIMEOUT_MS, Math.max(1, remaining)));
			for (const { target, key } of task.destinations) Reflect.set(target, key, redacted);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PAW_MAX_CONCURRENCY, tasks.length) }, () => worker()));
	for (const { source, parsed, holder, target, key } of serializedArguments) {
		const replacement = JSON.stringify(holder.value);
		Reflect.set(target, key, replacement === JSON.stringify(parsed) ? source : replacement);
	}
	return root.value;
}

export async function redactText(
	pi: ExtensionAPI,
	text: string,
	placeholder: string,
	signal?: AbortSignal,
	timeoutMs = PAW_TIMEOUT_MS,
): Promise<string> {
	const cmd = process.env.PAW_PII_CMD;
	if (!cmd) return regexRedact(text, placeholder);
	if (signal?.aborted) return placeholder;
	try {
		const result = await pi.exec(cmd, buildPawArgs(text, placeholder), { signal, timeout: timeoutMs });
		// A killed or cancelled NER invocation cannot certify names: fail
		// closed instead of sending its unexamined original back to the model.
		if (signal?.aborted || result.killed) return placeholder;
		if (result.code === 0 && result.stdout) return result.stdout.replace(/\r?\n$/, "");
		// Never log stdout/stderr or input, including when the CLI echoes it.
		pi.logger?.warn?.("PAW_PII_CMD failed; falling back to regex", {
			code: result.code,
			killed: result.killed,
		});
	} catch {
		if (signal?.aborted) return placeholder;
		pi.logger?.warn?.("PAW_PII_CMD failed to spawn; falling back to regex");
	}
	// Retain the example's documented zero-dependency fallback on CLI errors.
	return regexRedact(text, placeholder);
}

export default function piiRedactExtension(pi: ExtensionAPI) {
	pi.setLabel("PII Redaction (example)");
	const placeholder = process.env.PAW_PII_PLACEHOLDER || "[PII]";
	let enabled = process.env.PAW_PII_DISABLE !== "1";

	pi.registerCommand("pii", {
		description: "Toggle example PII redaction middleware",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			ctx.ui.notify(enabled ? "PII redaction on" : "PII redaction off", "info");
		},
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!enabled) return;
		// One work budget covers both model-visible blocks AND persisted details.
		// Failure results are just as sensitive as successes.
		const redacted = (await redactTextLeaves(
			pi,
			{ content: event.content, details: event.details },
			placeholder,
			ctx.signal,
			"messages",
		)) as { content: ToolResultContent; details: unknown };
		return redacted;
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled || !Array.isArray(event.messages)) return;
		const messages = (await redactTextLeaves(pi, event.messages, placeholder, ctx.signal, "messages")) as typeof event.messages;
		return { messages };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!enabled || event.payload == null) return;
		return await redactTextLeaves(pi, event.payload, placeholder, ctx.signal, "provider");
	});
}
