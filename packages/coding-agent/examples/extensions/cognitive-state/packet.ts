import { createHash } from "node:crypto";
import type { Claim, CognitiveStatePacket, EvidenceRef, FrozenQuestion, InformationNeed } from "./types.ts";
import { CONTEXT_RESOLVE_SCHEMA, STATE_PACKET_SCHEMA } from "./types.ts";

function sha16(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function claimText(ref: EvidenceRef): string {
	return ref.claim ?? ref.excerpt ?? ref.locator;
}

function toClaim(ref: EvidenceRef, status: Claim["status"]): Claim {
	return {
		entity: ref.entity ?? ref.source_id,
		text: claimText(ref),
		status,
		evidence_locator: ref.locator,
		source_id: ref.source_id,
		source_version: ref.source_version,
		observed_at: ref.observed_at,
		plane: ref.plane ?? "EXTERNAL",
	};
}

function byTime(a: EvidenceRef, b: EvidenceRef): number {
	if (a.observed_at !== b.observed_at) return a.observed_at < b.observed_at ? -1 : 1;
	return a.source_version < b.source_version ? -1 : a.source_version > b.source_version ? 1 : 0;
}

export interface CompileInput {
	intent: string;
	evidence: EvidenceRef[];
	needs?: InformationNeed[];
	question?: FrozenQuestion;
	dialogue?: string;
	rawSourceReads?: number;
	retrievalCapability?: string;
}

/**
 * Reduce evidence into a minimal packet.
 * Newer contradictory claims supersede; older claims stay in history.
 * Age alone never drops a claim.
 */
export function compileCognitiveState(input: CompileInput): CognitiveStatePacket {
	const groups = new Map<string, EvidenceRef[]>();
	for (const ref of input.evidence) {
		const entity = ref.entity ?? ref.source_id;
		const list = groups.get(entity) ?? [];
		list.push(ref);
		groups.set(entity, list);
	}

	const current: Claim[] = [];
	const history: Claim[] = [];
	const contradictions: string[] = [];

	for (const [entity, refs] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		const ordered = [...refs].sort(byTime);
		const latest = ordered[ordered.length - 1];
		if (!latest) continue;
		current.push(toClaim(latest, "observed"));
		const texts = new Set(ordered.map(claimText));
		for (const older of ordered.slice(0, -1)) {
			history.push(toClaim(older, texts.size > 1 ? "superseded" : "observed"));
		}
		if (texts.size > 1) {
			const previous = ordered[ordered.length - 2];
			contradictions.push(
				`${entity}: ${previous ? claimText(previous) : "?"} (${previous?.locator ?? "?"}) superseded by ${claimText(latest)} (${latest.locator}); both retained`,
			);
		}
	}

	const gaps: string[] = [];
	for (const need of input.needs ?? []) {
		if (need.required === false) continue;
		const hit = input.evidence.some(ref => ref.required_need === need.id || ref.source_id === need.id);
		if (!hit) gaps.push(`${need.id}: missing evidence`);
	}
	if (input.question) {
		for (const id of input.question.evidence_ids) {
			if (!input.evidence.some(ref => ref.source_id === id)) gaps.push(`${id}: missing evidence`);
		}
	}

	const uniqueGaps = [...new Set(gaps)];
	const nextAction =
		uniqueGaps.length > 0 ? "ABSTAIN" : input.question?.expected_action === "observe" ? "OBSERVE" : "ANSWER";

	const revision = sha16({
		current: current.map(claim => [claim.entity, claim.text, claim.evidence_locator]),
		gaps: uniqueGaps,
		locators: input.evidence.map(ref => ref.locator).sort(),
	});

	return {
		schema: STATE_PACKET_SCHEMA,
		source_schema: CONTEXT_RESOLVE_SCHEMA,
		question_id: input.question?.id,
		intent: input.intent,
		state: { current },
		knowledge: { history },
		work: uniqueGaps.map(gap => `resolve ${gap}`),
		decisions: [],
		evidence: input.evidence,
		dialogue_continuity: (input.dialogue ?? "").slice(0, 500),
		next_action: nextAction,
		unresolved_gaps: uniqueGaps,
		contradictions,
		revision,
		raw_source_reads: input.rawSourceReads ?? 0,
		retrieval_capability: input.retrievalCapability ?? "fixture",
	};
}

export function renderStatePacket(packet: CognitiveStatePacket): string {
	const lines = [
		`<${packet.schema} revision="${packet.revision}">`,
		`intent: ${packet.intent}`,
		`next_action: ${packet.next_action}`,
	];
	if (packet.next_action === "ABSTAIN") {
		lines.push("ABSTAIN: required evidence is missing");
	}
	lines.push("unresolved_gaps:");
	if (packet.unresolved_gaps.length === 0) lines.push("- none");
	for (const gap of packet.unresolved_gaps) lines.push(`- ${gap}`);
	lines.push("current:");
	for (const claim of packet.state.current) {
		lines.push(
			`- ${claim.entity}: ${claim.text} [${claim.evidence_locator} @ ${claim.observed_at} status=${claim.status} plane=${claim.plane}]`,
		);
	}
	lines.push("history:");
	if (packet.knowledge.history.length === 0) lines.push("- none");
	for (const claim of packet.knowledge.history) {
		lines.push(
			`- ${claim.entity}: ${claim.text} [${claim.evidence_locator} @ ${claim.observed_at} status=${claim.status} plane=${claim.plane}]`,
		);
	}
	lines.push("contradictions:");
	if (packet.contradictions.length === 0) lines.push("- none");
	for (const row of packet.contradictions) lines.push(`- ${row}`);
	lines.push("evidence:");
	for (const ref of packet.evidence) {
		lines.push(`- ${ref.source_id} ${ref.locator} ${ref.source_version}${ref.excerpt ? ` excerpt=${ref.excerpt}` : ""}`);
	}
	lines.push(`dialogue_continuity: ${packet.dialogue_continuity}`);
	lines.push(`</${packet.schema}>`);
	return lines.join("\n");
}

export interface SupportVerdict {
	answer_supported: boolean;
	abstained: boolean;
	verified: boolean;
	missing: string[];
}

/** Support is a property of the injected text plus evidence excerpts, not of retrieval alone. */
export function verifyAnswerSupport(
	visible: string,
	packet: CognitiveStatePacket,
	question: FrozenQuestion,
): SupportVerdict {
	const evidenceText = packet.evidence.map(ref => `${ref.excerpt ?? ""}\n${ref.claim ?? ""}`).join("\n");
	const missing = question.expected_support.filter(fact => !visible.includes(fact) || !evidenceText.includes(fact));
	const leaked = question.forbidden.filter(token => visible.includes(token));
	if (question.expected_action === "abstain") {
		const abstained = visible.includes("ABSTAIN") && packet.unresolved_gaps.length > 0 && leaked.length === 0;
		return { answer_supported: false, abstained, verified: abstained && missing.length === 0, missing };
	}
	if (question.expected_action === "observe") {
		const both = missing.length === 0 && packet.contradictions.length > 0 && leaked.length === 0;
		return { answer_supported: false, abstained: false, verified: both, missing };
	}
	const supported = missing.length === 0 && leaked.length === 0 && packet.next_action === "ANSWER";
	return { answer_supported: supported, abstained: false, verified: supported, missing };
}
