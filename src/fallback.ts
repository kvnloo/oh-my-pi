/**
 * Typed native-context fallback for canary mode.
 * Preserve exact native provider context; retry ONCE; do not mutate canonical history twice.
 */

export type FallbackReason =
	| "MISSING_EVIDENCE"
	| "VERIFIER_FAILURE"
	| "CONTEXT_INCONSISTENCY"
	| "UNRESOLVED_REFERENCE"
	| "TOOL_RECOVERY_LOOP"
	| "MANUAL_OPERATOR_FALLBACK"
	| "UNKNOWN";

export interface TurnAttemptIds {
	user_turn_id: string;
	causal_trace_id: string;
	virtual_attempt_id: string;
	fallback_attempt_id?: string;
}

export interface CanaryTurnRecord {
	ids: TurnAttemptIds;
	context_mode: "virtual" | "virtual_fallback_native";
	fallback_reason?: FallbackReason;
	virtual_verified: boolean;
	fallback_verified?: boolean;
	native_tokens: number;
	virtual_tokens: number;
	fallback_tokens?: number;
	compile_ms: number;
	task_class: string;
}

let seq = 0;
export function nextId(prefix: string): string {
	seq += 1;
	return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export function startTurnIds(userTurnId?: string): TurnAttemptIds {
	const user_turn_id = userTurnId ?? nextId("turn");
	return {
		user_turn_id,
		causal_trace_id: nextId("trace"),
		virtual_attempt_id: nextId("virt"),
	};
}

export function attachFallbackAttempt(ids: TurnAttemptIds): TurnAttemptIds {
	return { ...ids, fallback_attempt_id: nextId("fb") };
}

export class FallbackLedger {
	readonly turns: CanaryTurnRecord[] = [];

	record(turn: CanaryTurnRecord): void {
		this.turns.push(turn);
	}

	get fallback_count(): number {
		return this.turns.filter((t) => t.context_mode === "virtual_fallback_native").length;
	}

	reasons(): Record<string, number> {
		const out: Record<string, number> = {};
		for (const t of this.turns) {
			if (!t.fallback_reason) continue;
			out[t.fallback_reason] = (out[t.fallback_reason] ?? 0) + 1;
		}
		return out;
	}
}
