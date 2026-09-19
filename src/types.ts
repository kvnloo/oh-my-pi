export type ExecutorLane = "OMP_ROOT" | "AGY_RESEARCH" | "AGY_IMPLEMENT";

export type ExecutorMode = "manual" | "shadow-auto" | "auto";

export type AgyProcessState =
	| "UNLOADED"
	| "STARTING"
	| "READY"
	| "BUSY"
	| "FAILED"
	| "DRAINING";

export type ReceiptStatus =
	| "ok"
	| "error"
	| "timeout"
	| "unavailable"
	| "malformed"
	| "permission_denied"
	| "canceled";

export interface AgyUsage {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
}

export interface ResearchReceipt {
	task_id: string;
	role: "research";
	status: ReceiptStatus;
	findings: string[];
	evidence: string[];
	unresolved: string[];
	recommendation: string;
	conversation_id: string | null;
	model?: string | null;
	agent?: string | null;
	effort?: string | null;
	usage?: AgyUsage | null;
	duration_ms: number;
	raw_error?: string;
	cursor_calls_avoided: 1;
	executor: "agy";
	/** Present when AgyDriver managed settings.json permissions for this turn. */
	permissions?: {
		applied: boolean;
		restored: boolean;
		tag?: string;
	};
}

export interface WorkReceipt {
	task_id: string;
	role: "implementation";
	status: ReceiptStatus;
	repo: string;
	worktree: string;
	base_sha: string | null;
	head_sha: string | null;
	changed_files: string[];
	tests: { ran: boolean; passed?: boolean; command?: string; output_excerpt?: string };
	verifier: { ok: boolean; name?: string; detail?: string };
	findings: string[];
	blockers: string[];
	artifacts: string[];
	conversation_id: string | null;
	model?: string | null;
	agent?: string | null;
	effort?: string | null;
	usage?: AgyUsage | null;
	duration_ms: number;
	raw_error?: string;
	parent_checkout_untouched: true;
	cursor_calls_avoided: 1;
	executor: "agy";
	/** Present when AgyDriver managed settings.json permissions for this turn. */
	permissions?: {
		applied: boolean;
		restored: boolean;
		tag?: string;
	};
}

export interface RoutingDecision {
	predicted: ExecutorLane;
	selected: ExecutorLane;
	confidence: number;
	mode: ExecutorMode;
	reason: string;
	features: Record<string, string | number | boolean>;
	shadow_only: boolean;
}

export interface ProviderPressureSnapshot {
	omp_active_sessions?: number;
	recent_429_or_rate_limit: number;
	queue_retry_latency_ms?: number;
	provider_family?: string;
	agy_ready: number;
	agy_busy: number;
	agy_failed: number;
	agy_queue_depth: number;
	agy_recent_failures: number;
	agy_p50_latency_ms?: number;
	ts: number;
}
