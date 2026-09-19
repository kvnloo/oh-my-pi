/**
 * Tool-result → RLM spill → deterministic receipt.
 * Canonical transcript stays unchanged; receipts feed the shadow packet.
 */

import type { ToolReceiptV1, EvidenceKind, VisibilityClass } from "./schema.ts";
import { classifyVisibility } from "./visibility.ts";
import { formatEvidenceSource, type SpillStore } from "./rlm-adapter.ts";

export interface ToolResultInput {
	tool: string;
	tool_call_id: string;
	is_error?: boolean;
	output: string;
	turn?: number;
	parent_user_excerpt?: string;
	verifier?: string;
	kind?: EvidenceKind;
	facts?: string[];
}

const FACT_PATTERNS: Array<{ re: RegExp; label: string }> = [
	{ re: /(\d+)\s*\/\s*(\d+)\s*(?:tests?\s*)?pass/i, label: "pass_count" },
	{ re: /(\d+)\s+fail(?:ed|ures?)?/i, label: "fail_count" },
	{ re: /\bexit(?:\s+code)?[=:\s]+(-?\d+)/i, label: "exit_code" },
	{ re: /\b([0-9a-f]{7,40})\b/, label: "sha_like" },
	{ re: /\berror:\s*(.+)/i, label: "error_line" },
	{ re: /\bPASS\b|\bFAIL\b|\bOK\b/, label: "status_word" },
];

export function extractFacts(output: string, max = 8): string[] {
	const facts: string[] = [];
	const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (const { re } of FACT_PATTERNS) {
		const m = output.match(re);
		if (m) facts.push(m[0].slice(0, 120));
		if (facts.length >= max) break;
	}
	const informative = lines.filter((l) => l.length < 200 && !/^(.)\1{20,}/.test(l));
	if (facts.length < 2 && informative.length) {
		facts.push(`head:${informative[0]!.slice(0, 120)}`);
		if (informative.length > 1) {
			facts.push(`tail:${informative[informative.length - 1]!.slice(0, 120)}`);
		}
	}
	return [...new Set(facts)].slice(0, max);
}

export function createToolReceipt(store: SpillStore, input: ToolResultInput): ToolReceiptV1 {
	const kind: EvidenceKind = input.kind ?? "tool_output";
	const resolvedStatus: "ok" | "error" = input.is_error ? "error" : "ok";
	const facts = input.facts?.length ? input.facts : extractFacts(input.output);
	const spill = store.put(input.output, formatEvidenceSource(kind, input.tool));
	const unresolved = resolvedStatus === "error";
	const visibility: VisibilityClass = classifyVisibility({
		kind: "tool_result",
		status: resolvedStatus,
		has_receipt: true,
		unresolved,
		verified: Boolean(input.verifier) && !unresolved,
	});

	return {
		schema: "z0.tool_receipt.v1",
		tool: input.tool,
		tool_call_id: input.tool_call_id,
		status: resolvedStatus,
		facts,
		artifact_handle: spill.handle,
		raw_bytes: spill.bytes,
		raw_sha256: spill.sha256,
		verifier: input.verifier,
		causal_provenance: {
			turn: input.turn,
			parent_user_excerpt: input.parent_user_excerpt?.slice(0, 240),
		},
		visibility,
		kind,
		created_at: Date.now(),
	};
}
