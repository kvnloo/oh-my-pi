/**
 * Deterministic context-failure diagnostics for canary.
 * Keep UNKNOWN when attribution is ambiguous.
 */

import type { CognitiveStatePacket } from "./schema.ts";
import type { FixtureMessage } from "./compiler.ts";
import type { SpillStore } from "./rlm-adapter.ts";
import type { FallbackReason } from "./fallback.ts";

export interface DiagnosticFinding {
	reason: FallbackReason;
	detail: string;
}

export interface DiagnoseInput {
	packet: CognitiveStatePacket;
	store: SpillStore;
	/** Model/assistant output after virtual attempt (optional). */
	assistant_text?: string;
	/** Whether a verifier for the turn failed. */
	verifier_failed?: boolean;
	/** Whether native paired replay passed the same verifier. */
	native_verifier_passed?: boolean;
	/** Tool call count in virtual attempt (loop detector). */
	tool_calls?: number;
	/** Same tool called repeatedly for already-known receipt. */
	repeated_known_state_requests?: number;
	/** Operator forced fallback. */
	manual_fallback?: boolean;
}

const HANDLE_RE = /(?:rlm|z0):\/\/h\/[A-Za-z0-9_-]+/g;
const ASK_MISSING_RE =
	/\b(earlier (output|log|transcript)|full (raw )?output|what was the (previous|prior)|paste the (log|output)|missing context)\b/i;

export function diagnoseContextFailure(input: DiagnoseInput): DiagnosticFinding | null {
	if (input.manual_fallback) {
		return { reason: "MANUAL_OPERATOR_FALLBACK", detail: "operator_requested_fallback" };
	}

	// unresolved evidence handles in packet
	for (const ev of input.packet.evidence) {
		const got = input.store.get(ev.handle);
		if (!got) {
			return { reason: "MISSING_EVIDENCE", detail: `unresolved_handle:${ev.handle}` };
		}
	}
	for (const id of input.packet.diagnostics.missing_required_evidence) {
		return { reason: "MISSING_EVIDENCE", detail: `missing_required:${id}` };
	}

	if (input.verifier_failed && input.native_verifier_passed) {
		return { reason: "VERIFIER_FAILURE", detail: "virtual_fail_native_pass" };
	}

	const text = input.assistant_text ?? "";
	const handles = text.match(HANDLE_RE) ?? [];
	for (const h of handles) {
		if (!input.store.get(h) && !input.packet.evidence.some((e) => e.handle === h)) {
			return { reason: "UNRESOLVED_REFERENCE", detail: `assistant_cited_missing:${h}` };
		}
	}

	// model references fact absent from virtual packet (deterministic: quoted sha/pass count not in packet JSON)
	const packetBlob = JSON.stringify(input.packet);
	const shaMentions = text.match(/\b[0-9a-f]{7,40}\b/g) ?? [];
	for (const sha of shaMentions) {
		if (sha.length >= 7 && !packetBlob.includes(sha) && !/^[0-9a-f]+$/.test(sha.slice(0, 2) + "x")) {
			// only flag if looks like commit/sha and absent from packet+evidence
			const inEvidence = input.packet.evidence.some((e) => e.sha256?.includes(sha));
			const inKnowledge = input.packet.knowledge.some((k) => k.claim.includes(sha));
			if (!inEvidence && !inKnowledge && sha.length >= 12) {
				return { reason: "CONTEXT_INCONSISTENCY", detail: `fact_absent_from_packet:${sha.slice(0, 12)}` };
			}
		}
	}

	if ((input.repeated_known_state_requests ?? 0) >= 2) {
		return { reason: "TOOL_RECOVERY_LOOP", detail: "repeated_request_for_known_state" };
	}

	if ((input.tool_calls ?? 0) >= 6 && /again|already|same/i.test(text)) {
		return { reason: "TOOL_RECOVERY_LOOP", detail: "high_tool_calls_with_repeat_language" };
	}

	if (ASK_MISSING_RE.test(text)) {
		return { reason: "UNRESOLVED_REFERENCE", detail: "model_asked_for_missing_earlier_context" };
	}

	if (input.verifier_failed && input.native_verifier_passed === undefined) {
		return { reason: "UNKNOWN", detail: "verifier_failed_attribution_ambiguous" };
	}

	return null;
}

/** Pre-flight checks before sending virtual context (no assistant yet). */
export function preflightVirtualContext(
	packet: CognitiveStatePacket,
	store: SpillStore,
	virtual: FixtureMessage[],
): DiagnosticFinding | null {
	for (const ev of packet.evidence) {
		if (!store.get(ev.handle)) {
			return { reason: "MISSING_EVIDENCE", detail: `preflight_unresolved:${ev.handle}` };
		}
	}
	for (const m of virtual) {
		if (m.role !== "tool") continue;
		const handles = m.content.match(HANDLE_RE) ?? [];
		for (const h of handles) {
			if (!store.get(h)) {
				return { reason: "MISSING_EVIDENCE", detail: `virtual_tool_stub_missing:${h}` };
			}
		}
	}
	if (packet.diagnostics.missing_required_evidence.length) {
		return {
			reason: "MISSING_EVIDENCE",
			detail: `preflight_missing_required:${packet.diagnostics.missing_required_evidence.join(",")}`,
		};
	}
	return null;
}
