import type { ContextMessage, EvidenceQualityLabel, EvidenceRef, FrozenQuestion, HarnessReceipt } from "./types.ts";
import { RLM_DONOR_SPILL_BYTES } from "./types.ts";
import { FROZEN_QUESTIONS, PUBLIC_EVIDENCE, matchFrozenQuestion } from "./frozen.ts";
import { growthFromPrevious, measureArms } from "./measure.ts";
import { compileCognitiveState, renderStatePacket, verifyAnswerSupport } from "./packet.ts";
import { contextBytes, messageText } from "./spill.ts";

export type CognitiveMode = "off" | "shadow" | "canary";

export interface CognitiveStateConfig {
	mode: CognitiveMode;
	sessionId: string;
	traceId: string;
	spillBytes?: number;
	evidence?: readonly EvidenceRef[];
	receipt?: ReceiptLog;
	sourceRevision?: string;
	previousArms?: HarnessReceipt["arms"];
}

export class ReceiptLog {
	readonly lines: HarnessReceipt[] = [];
	#seen = new Set<string>();

	/** Append-only eval artifact. Replay of the same key is not a second injection. */
	record(row: HarnessReceipt): boolean {
		const key = `${row.session_id}|${row.trace_id}|${row.question_id}|${row.revision}|${row.mode}|${row.sent}`;
		if (this.#seen.has(key)) return false;
		this.#seen.add(key);
		this.lines.push(row);
		return true;
	}
}

export interface HandleResult {
	mode: CognitiveMode;
	injected: boolean;
	replacement?: ContextMessage[];
	sent: "native" | "state-packet" | "off";
	visibleText: string;
	receipt?: HarnessReceipt;
	replayed: boolean;
}

function latestUser(messages: readonly ContextMessage[]): ContextMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user") return message;
	}
	return undefined;
}

function evidenceFor(question: FrozenQuestion | undefined, bundle: readonly EvidenceRef[]): EvidenceRef[] {
	if (!question) return [...bundle];
	const allowed = new Set(question.evidence_ids);
	return bundle.filter(ref => allowed.has(ref.source_id) || (ref.required_need !== undefined && question.needs.some(need => need.id === ref.required_need)));
}

function quality(answerSupported: boolean, abstained: boolean): EvidenceQualityLabel {
	if (abstained) return "MISSED_EVIDENCE";
	if (answerSupported) return "SUPPORTED";
	return "UNSUPPORTED";
}

/**
 * Context-event decision.
 * Shadow records the packet and returns no replacement, so the host sends native messages.
 * Canary replaces the provider view only for a frozen z0evals#56 marker.
 * Neither path writes the canonical transcript.
 */
export async function handleCognitiveStateContext(
	event: { type: "context"; messages: readonly ContextMessage[] },
	config: CognitiveStateConfig,
): Promise<HandleResult> {
	const native = event.messages;
	if (config.mode === "off") {
		return { mode: "off", injected: false, sent: "off", visibleText: native.map(messageText).join("\n"), replayed: false };
	}

	const started = performance.now();
	const user = latestUser(native);
	const userText = user ? messageText(user) : "";
	const question = matchFrozenQuestion(userText);
	const bundle = question ? (config.evidence ?? PUBLIC_EVIDENCE) : (config.evidence ?? []);
	const selected = evidenceFor(question, bundle);
	const needs =
		question?.needs ??
		(selected.length === 0 ? [{ id: "unscoped", description: "no evidence compiled", required: true }] : []);
	const intent = question?.prompt ?? userText.slice(0, 500);
	const packet = compileCognitiveState({
		intent,
		evidence: selected,
		needs,
		question,
		dialogue: userText,
		rawSourceReads: 0,
		retrievalCapability: question ? "fixture" : "none",
	});
	const packetText = renderStatePacket(packet);
	const canary = config.mode === "canary" && question !== undefined;
	const replacement = canary
		? [
				{
					role: "user",
					content: packetText,
					timestamp: user?.timestamp ?? 0,
					attribution: "agent" as const,
					synthetic: true,
				},
				...(user ? [user] : []),
			]
		: undefined;
	const sentMessages = replacement ?? native;
	const arms = measureArms(native, packetText, config.spillBytes ?? RLM_DONOR_SPILL_BYTES);
	const verdict = question ? verifyAnswerSupport(packetText, packet, question) : undefined;
	const sent = canary ? "state-packet" : "native";
	const receipt: HarnessReceipt = {
		harness: "omp",
		question_id: question?.id ?? "unscoped",
		session_id: config.sessionId,
		trace_id: config.traceId,
		source_revision: config.sourceRevision ?? "unspecified",
		retrieval_capability: packet.retrieval_capability,
		evidence_refs: packet.evidence.map(ref => ref.locator),
		injected: canary,
		answer_supported: canary ? (verdict?.answer_supported ?? false) : false,
		abstained: packet.next_action === "ABSTAIN",
		raw_source_reads: packet.raw_source_reads,
		context_bytes: canary ? contextBytes(sentMessages) : contextBytes(native),
		latency_ms: performance.now() - started,
		duplicate_injection: false,
		verified: canary ? (verdict?.verified ?? false) : false,
		mode: canary ? "canary" : "shadow",
		sent,
		would_send_bytes: Buffer.byteLength(packetText, "utf8"),
		evidence_quality: quality(verdict?.answer_supported ?? false, packet.next_action === "ABSTAIN"),
		arms,
		root_context_growth_per_turn: growthFromPrevious(arms, config.previousArms),
		replayed: false,
	};

	let appended = true;
	if (config.receipt) appended = config.receipt.record(receipt);
	if (!appended) {
		return {
			mode: config.mode,
			injected: canary,
			replacement,
			sent,
			visibleText: canary ? packetText : native.map(messageText).join("\n"),
			receipt: { ...receipt, replayed: true, duplicate_injection: false },
			replayed: true,
		};
	}
	return {
		mode: config.mode,
		injected: canary,
		replacement,
		sent,
		visibleText: canary ? packetText : native.map(messageText).join("\n"),
		receipt,
		replayed: false,
	};
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): CognitiveStateConfig {
	const mode = env.OMP_COGNITIVE_STATE;
	return {
		mode: mode === "off" || mode === "canary" || mode === "shadow" ? mode : "shadow",
		sessionId: env.OMP_COGNITIVE_STATE_SESSION ?? "unset",
		traceId: env.OMP_COGNITIVE_STATE_TRACE ?? "unset",
		sourceRevision: env.OMP_SOURCE_REVISION,
	};
}

export function frozenQuestionIds(): string[] {
	return FROZEN_QUESTIONS.map(question => question.id);
}

export function createCognitiveStateHandler(config: CognitiveStateConfig) {
	return async (event: { type: "context"; messages: readonly ContextMessage[] }) => {
		const result = await handleCognitiveStateContext(event, config);
		if (!result.replacement) return;
		return { messages: result.replacement };
	};
}
