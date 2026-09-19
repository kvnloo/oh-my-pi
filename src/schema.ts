/**
 * z0.cognitive_state.v1 — bounded CognitiveStatePacket.
 * Structured slots only; no giant prose summary.
 */

export const COGNITIVE_STATE_SCHEMA = "z0.cognitive_state.v1" as const;

export type VisibilityClass = "LIVE" | "RECEIPT" | "EXTERNAL" | "ARCHIVED";

/** Generic RLM spill kinds encoded in `source` (kind[/subtype]). */
export type EvidenceKind =
	| "tool_output"
	| "worker_transcript"
	| "plan"
	| "benchmark"
	| "git_diff"
	| "research"
	| "verification"
	| "other";

export interface CognitiveIntent {
	objective: string;
	acceptance: string[];
	invariants: string[];
	authority: string;
	budgets: {
		max_live_items?: number;
		max_receipt_items?: number;
		max_evidence_handles?: number;
	};
}

export interface CognitiveStateSlice {
	current_phase: string;
	current_bottleneck: string;
	repo_worktree: string;
	plan_generation?: string;
}

export interface KnowledgeItem {
	claim: string;
	status: "established" | "provisional" | "contradicted";
	visibility: VisibilityClass;
	evidence_handle?: string;
}

export interface WorkItem {
	id: string;
	summary: string;
	status: "active" | "pending" | "recently_completed" | "stale";
	visibility: VisibilityClass;
	tool?: string;
	evidence_handle?: string;
}

export interface DecisionItem {
	id: string;
	question: string;
	status: "unresolved" | "recently_resolved";
	resolution?: string;
	visibility: VisibilityClass;
}

export interface EvidenceRef {
	handle: string;
	kind: EvidenceKind;
	visibility: VisibilityClass;
	sha256?: string;
	bytes?: number;
	tool?: string;
	status?: string;
	verifier?: string;
}

export interface DialogueSlice {
	latest_user_input: string;
	open_commitments: string[];
}

export interface NextAction {
	recommended: string;
	alternatives: string[];
}

export interface VisibilityCounts {
	LIVE: number;
	RECEIPT: number;
	EXTERNAL: number;
	ARCHIVED: number;
}

export interface CognitiveStatePacket {
	schema: typeof COGNITIVE_STATE_SCHEMA;
	compiled_at: number;
	session_id?: string;
	intent: CognitiveIntent;
	state: CognitiveStateSlice;
	knowledge: KnowledgeItem[];
	work: WorkItem[];
	decisions: DecisionItem[];
	evidence: EvidenceRef[];
	dialogue: DialogueSlice;
	next: NextAction;
	visibility_counts: VisibilityCounts;
	diagnostics: {
		native_estimated_tokens: number;
		virtual_estimated_tokens: number;
		live_tokens: number;
		receipt_tokens: number;
		evidence_tokens: number;
		externalized_bytes: number;
		compile_ms: number;
		missing_required_evidence: string[];
		/** True while mode is shadow/off; false once canary sends virtual. */
		shadow_only: boolean;
		provider_receives: "native" | "virtual";
		context_mode?: "native" | "virtual" | "virtual_fallback_native";
	};
}

export interface ToolReceiptV1 {
	schema: "z0.tool_receipt.v1";
	tool: string;
	tool_call_id: string;
	status: "ok" | "error";
	facts: string[];
	artifact_handle: string;
	raw_bytes: number;
	raw_sha256: string;
	verifier?: string;
	causal_provenance: {
		turn?: number;
		parent_user_excerpt?: string;
	};
	visibility: VisibilityClass;
	kind: EvidenceKind;
	created_at: number;
}

export interface ShadowContextEconomics {
	native_context_tokens: number;
	virtual_context_tokens: number;
	compile_ms: number;
	receipt_tokens: number;
	live_tokens: number;
	evidence_tokens: number;
	externalized_bytes: number;
	/**
	 * 0 in shadow / fallback / failed virtual.
	 * May be >0 only for verified virtual-success turns.
	 */
	measured_tokens_avoided: number;
	live_count: number;
	receipt_count: number;
	external_count: number;
	archived_count: number;
	selected_evidence_handles: string[];
	missing_required_evidence: string[];
	shadow_only: boolean;
	context_mode: "native" | "virtual" | "virtual_fallback_native";
}
