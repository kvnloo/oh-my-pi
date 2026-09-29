import { createHash } from "node:crypto";
import type { ContextMessage } from "./types.ts";
import { RLM_DONOR_SPILL_BYTES, RLM_PREVIEW_CHARS } from "./types.ts";

/**
 * Byte model of donor `maybeSpill` / `stubFor`.
 * Does not open an RLM store and does not persist spilled payloads.
 */
export function donorSpillStub(text: string, spillBytes: number, id: string, source?: string): string {
	if (Buffer.byteLength(text, "utf8") <= spillBytes) return text;
	const sha256 = createHash("sha256").update(text).digest("hex");
	const bytes = Buffer.byteLength(text, "utf8");
	const head = text.slice(0, RLM_PREVIEW_CHARS);
	const tail = text.length > RLM_PREVIEW_CHARS ? text.slice(-RLM_PREVIEW_CHARS) : "";
	const preview = tail && text.length > RLM_PREVIEW_CHARS * 2 ? `${head}\n…\n${tail}` : head;
	return [
		`[rlm spilled handle=rlm://h/${id} bytes=${bytes} sha256=${sha256}${source ? ` source=${source}` : ""}]`,
		"Full payload is NOT in this message. Use the rlm tool (peek/search/query) on the handle.",
		preview,
	].join("\n");
}

export function messageText(message: ContextMessage): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.map(part => (part.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

/** Arm B: spill oversized tool-result text. Other roles stay intact. */
export function applySpillOnly(messages: readonly ContextMessage[], spillBytes = RLM_DONOR_SPILL_BYTES): ContextMessage[] {
	let nextId = 1;
	return messages.map(message => {
		if (message.role !== "toolResult") return message;
		if (typeof message.content === "string") {
			const id = String(nextId++);
			return { ...message, content: donorSpillStub(message.content, spillBytes, id, message.toolName) };
		}
		if (!Array.isArray(message.content)) return message;
		const content = message.content.map(part => {
			if (part.type !== "text" || typeof part.text !== "string") return part;
			const id = String(nextId++);
			return { ...part, text: donorSpillStub(part.text, spillBytes, id, message.toolName) };
		});
		return { ...message, content };
	});
}

export function contextBytes(messages: readonly ContextMessage[]): number {
	let total = 0;
	for (const message of messages) total += Buffer.byteLength(messageText(message), "utf8");
	return total;
}
