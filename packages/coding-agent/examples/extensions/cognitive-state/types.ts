/** Provider-view packet. Canonical JSONL is not this type and is never written here. */

export const STATE_PACKET_SCHEMA = "z0.cognitive_state.v1";
export const CONTEXT_RESOLVE_SCHEMA = "z0int.context_resolve.v1";
export const CANARY_MARKER = "z0evals#56:";

/** Donor PR #77 store.ts — measurement only, not a merged RLM runtime. */
export const RLM_DONOR_SPILL_BYTES = 20_480;
export const RLM_PREVIEW_CHARS = 240;
export const RLM_DONOR_REF = "kvnloo/oh-my-pi#77:packages/coding-agent/src/rlm/store.ts#stubFor";

export type TrustClass =
	| "authoritative_task"
	| "project_constraint"
	| "code"
	| "conversation"
	| "derived_memory"
	| "index_hit"
	| "unknown";

export type EvidencePlane = "LIVE" | "RECEIPT" | "EXTERNAL";

export type ClaimStatus =
	| "unknown"
	| "provisional"
	| "observed"
	| "verified"
	| "contradicted"
	| "stale"
	| "superseded";

export type NextAction = "ANSWER" | "ABSTAIN" | "OBSERVE";

/** z0int.context_resolve.v1 EvidenceRef, plus optional claim identity for reduction. */
export interface EvidenceRef {
	source_id: string;
	source_version: string;
	locator: string;
	trust_class: TrustClass;
	observed_at: string;
	excerpt?: string;
	note?: string;
	entity?: string;
	claim?: string;
	plane?: EvidencePlane;
	required_need?: string;
}

export interface InformationNeed {
	id: string;
	description: string;
	kind?: "exact_path" | "exact_symbol" | "natural_language" | "memory";
	path?: string;
	required?: boolean;
}

export interface Claim {
	entity: string;
	text: string;
	status: ClaimStatus;
	evidence_locator: string;
	source_id: string;
	source_version: string;
	observed_at: string;
	plane: EvidencePlane;
}

export interface CognitiveStatePacket {
	schema: typeof STATE_PACKET_SCHEMA;
	source_schema: typeof CONTEXT_RESOLVE_SCHEMA;
	question_id?: string;
	intent: string;
	state: { current: Claim[] };
	knowledge: { history: Claim[] };
	work: string[];
	decisions: string[];
	evidence: EvidenceRef[];
	dialogue_continuity: string;
	next_action: NextAction;
	unresolved_gaps: string[];
	contradictions: string[];
	revision: string;
	raw_source_reads: number;
	retrieval_capability: string;
}

export interface FrozenQuestion {
	id: string;
	family: string;
	prompt: string;
	needs: InformationNeed[];
	expected_action: "answer" | "abstain" | "observe";
	expected_support: string[];
	forbidden: string[];
	evidence_ids: string[];
}

/** Structural provider message. The context handler never persists these. */
export interface ContextMessage {
	role: string;
	content?: string | Array<{ type?: string; text?: string }>;
	toolName?: string;
	timestamp?: number;
	attribution?: string;
	synthetic?: boolean;
}

export type EvidenceQualityLabel = "SUPPORTED" | "WRONG_CITATION" | "UNSUPPORTED" | "MISSED_EVIDENCE";

export interface ArmBytes {
	native_context_bytes: number;
	rlm_spill_bytes: number;
	state_packet_bytes: number;
}

export const UNIFIED_RECEIPT_SCHEMA = "z0eval.unified_memory_receipt.v0";

/** Wire object. No arm, mode, or growth fields — those stay in OMP analysis. */
export interface UnifiedEvidenceRef {
	source_id: string;
	source_version: string;
	trust_class: string;
	locator_hash?: string;
}

export interface UnifiedMemoryReceipt {
	schema: typeof UNIFIED_RECEIPT_SCHEMA;
	harness: "omp";
	question_id: string;
	session_id: string;
	trace_id: string;
	harness_revision: string;
	retrieval_capability: string;
	retrieval_ok: boolean;
	injected: boolean;
	answer_supported: boolean;
	verified: boolean;
	abstained: boolean;
	duplicate_injection: boolean;
	evidence_refs: UnifiedEvidenceRef[];
	latency_ms: number;
	context_bytes: number;
	raw_source_reads: number;
}

export interface OmpContextAnalysis {
	mode: "shadow" | "canary";
	sent: "native" | "state-packet";
	would_send_bytes: number;
	evidence_quality: EvidenceQualityLabel;
	arms: ArmBytes;
	root_context_growth_per_turn: ArmBytes;
}
