/**
 * Context economics emitter for shadow + canary modes.
 * measured_tokens_avoided only counted on verified virtual-success.
 */

import type { ShadowContextEconomics } from "./schema.ts";
import type { CognitiveStateMode, ContextMode } from "./mode.ts";
import type { FallbackReason } from "./fallback.ts";

export interface ShadowEconomicsEvent {
	kind: "context";
	name: "omp.cognitive_state.shadow_context";
	status: "ok";
	shadow_only: true;
	context: ShadowContextEconomics;
	attributes: Record<string, string | number | boolean>;
	ts: number;
}

export interface CanaryEconomicsEvent {
	kind: "context";
	name: "omp.cognitive_state.canary_context";
	status: "ok" | "fallback";
	shadow_only: boolean;
	context: ShadowContextEconomics;
	attributes: Record<string, string | number | boolean>;
	ts: number;
}

export function makeShadowEconomicsEvent(econ: ShadowContextEconomics): ShadowEconomicsEvent {
	return {
		kind: "context",
		name: "omp.cognitive_state.shadow_context",
		status: "ok",
		shadow_only: true,
		context: { ...econ, measured_tokens_avoided: 0, shadow_only: true, context_mode: "native" },
		attributes: {
			"tokenomics.context.policy": "shadow_cognitive_state_v1",
			"tokenomics.context_mode": "native",
			"cognitive_state.native_tokens": econ.native_context_tokens,
			"cognitive_state.virtual_tokens": econ.virtual_context_tokens,
			"cognitive_state.compile_ms": econ.compile_ms,
			"cognitive_state.measured_tokens_avoided": 0,
			"cognitive_state.shadow_only": true,
		},
		ts: Date.now(),
	};
}

export function makeCanaryEconomicsEvent(
	econ: ShadowContextEconomics,
	meta: {
		context_mode: ContextMode;
		mode: CognitiveStateMode;
		task_class: string;
		attempt: string;
		fallback_reason?: FallbackReason;
		virtual_attempt_id?: string;
		fallback_attempt_id?: string;
		user_turn_id?: string;
		causal_trace_id?: string;
	},
): CanaryEconomicsEvent {
	const avoided =
		meta.context_mode === "virtual" && meta.attempt === "virtual_success"
			? econ.measured_tokens_avoided
			: 0;
	return {
		kind: "context",
		name: "omp.cognitive_state.canary_context",
		status: meta.context_mode === "virtual_fallback_native" ? "fallback" : "ok",
		shadow_only: meta.mode !== "canary" || meta.context_mode === "native",
		context: { ...econ, measured_tokens_avoided: avoided, context_mode: meta.context_mode },
		attributes: {
			"tokenomics.context.policy": "canary_cognitive_state_v1",
			"tokenomics.context_mode": meta.context_mode,
			"cognitive_state.mode": meta.mode,
			"cognitive_state.task_class": meta.task_class,
			"cognitive_state.attempt": meta.attempt,
			"cognitive_state.native_tokens": econ.native_context_tokens,
			"cognitive_state.virtual_tokens": econ.virtual_context_tokens,
			"cognitive_state.compile_ms": econ.compile_ms,
			"cognitive_state.measured_tokens_avoided": avoided,
			...(meta.fallback_reason ? { "cognitive_state.fallback_reason": meta.fallback_reason } : {}),
			...(meta.virtual_attempt_id ? { "cognitive_state.virtual_attempt_id": meta.virtual_attempt_id } : {}),
			...(meta.fallback_attempt_id ? { "cognitive_state.fallback_attempt_id": meta.fallback_attempt_id } : {}),
			...(meta.user_turn_id ? { "cognitive_state.user_turn_id": meta.user_turn_id } : {}),
			...(meta.causal_trace_id ? { "cognitive_state.causal_trace_id": meta.causal_trace_id } : {}),
		},
		ts: Date.now(),
	};
}

export class ShadowEconomicsSink {
	readonly events: Array<ShadowEconomicsEvent | CanaryEconomicsEvent> = [];

	emit(econ: ShadowContextEconomics): ShadowEconomicsEvent {
		const ev = makeShadowEconomicsEvent(econ);
		this.events.push(ev);
		return ev;
	}

	emitCanary(ev: CanaryEconomicsEvent): CanaryEconomicsEvent {
		this.events.push(ev);
		return ev;
	}
}
