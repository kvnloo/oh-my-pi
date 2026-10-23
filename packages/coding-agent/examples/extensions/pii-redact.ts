/**
 * PII redaction extension (pattern + lightweight fallback)
 *
 * Demonstrates first-class privacy middleware on the extension event bus:
 *   - tool_result              — scrub tool output (success and error) before it re-enters context
 *   - context                  — rewrite AgentMessage[] before the LLM call
 *   - before_provider_request  — last-mile provider payload scrub (strings + structured objects)
 *
 * This example ships a small regex fallback so it runs with zero deps.
 * For production NER (names, addresses, multilingual PII) point
 * PAW_PII_CMD at the local ProgramAsWeights CLI from:
 *   https://github.com/kvnloo/pii  (integrations/omp package: omp-paw-pii)
 *
 * Complements built-in secrets.enabled (credentials) — does not replace it.
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

interface TextDestination {
	target: object;
	key: string;
}

interface TextTask {
	text: string;
	destinations: TextDestination[];
}

/**
 * One graph-preserving async mapper for context, persisted tool results, and
 * structured provider requests. Every string leaf passes through the same
 * configured detector. No joining of independent content or unsupported CLI
 * batching; repeated text is detected once per event.
 */
export async function redactTextLeaves(
	pi: ExtensionAPI,
	input: unknown,
	placeholder: string,
	signal?: AbortSignal,
): Promise<unknown> {
	const root: { value?: unknown } = {};
	const seen = new WeakMap<object, object>();
	const queue: Array<{ source: object; target: object }> = [];
	const tasks: TextTask[] = [];
	const byText = new Map<string, TextTask>();

	const visit = (value: unknown, target: object, key: string): void => {
		if (typeof value === "string") {
			if (value.length === 0) {
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
			// Typed arrays, buffers, dates, provider-native objects and their
			// internal state must keep their original identity and wire type.
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
		queue.push({ source: value, target: copy });
	};

	visit(input, root, "value");
	for (let index = 0; index < queue.length; index++) {
		const { source, target } = queue[index]!;
		const kind = "type" in source ? Reflect.get(source, "type") : undefined;
		for (const [key, child] of Object.entries(source)) {
			// Image bytes are opaque even when carried as a base64 string.
			if (key === "data" && (kind === "image" || kind === "input_image")) {
				Reflect.set(target, key, child);
				continue;
			}
			visit(child, target, key);
		}
	}

	const deadline = performance.now() + PAW_EVENT_BUDGET_MS;
	const configured = Boolean(process.env.PAW_PII_CMD);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < tasks.length) {
			const task = tasks[cursor++]!;
			const remaining = Math.floor(deadline - performance.now());
			// After the bounded detector budget, scrub the *entire* remaining
			// leaf: a regex-only result could leak configured NER-only names.
			const redacted =
				signal?.aborted || (configured && remaining < 100)
					? placeholder
					: await redactText(pi, task.text, placeholder, signal, Math.min(PAW_TIMEOUT_MS, Math.max(1, remaining)));
			for (const { target, key } of task.destinations) Reflect.set(target, key, redacted);
		}
	};
	await Promise.all(Array.from({ length: Math.min(PAW_MAX_CONCURRENCY, tasks.length) }, () => worker()));
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
		)) as { content: ToolResultContent; details: unknown };
		return redacted;
	});

	pi.on("context", async (event, ctx) => {
		if (!enabled || !Array.isArray(event.messages)) return;
		const messages = (await redactTextLeaves(pi, event.messages, placeholder, ctx.signal)) as typeof event.messages;
		return { messages };
	});

	pi.on("before_provider_request", async (event, ctx) => {
		if (!enabled || event.payload == null) return;
		return await redactTextLeaves(pi, event.payload, placeholder, ctx.signal);
	});
}
