import type { ResearchReceipt, WorkReceipt, RoutingDecision, ProviderPressureSnapshot } from "./types.ts";

export interface AgyTokenomicsEvent {
	kind: "llm" | "context" | "executor";
	name: "omp.agy.research" | "omp.agy.implementation" | "omp.agy.route" | "omp.agy.pressure";
	status: "ok" | "error" | "fallback";
	service: "agy" | "omp";
	role: "research" | "implementation" | "router" | "root";
	attributes: Record<string, string | number | boolean | null>;
	ts: number;
}

export function emitResearchEvent(r: ResearchReceipt, route?: RoutingDecision): AgyTokenomicsEvent {
	return {
		kind: "executor",
		name: "omp.agy.research",
		status: r.status === "ok" ? "ok" : "error",
		service: "agy",
		role: "research",
		attributes: {
			service: "agy",
			role: "research",
			task_id: r.task_id,
			conversation_id: r.conversation_id,
			model: r.model ?? null,
			agent: r.agent ?? null,
			effort: r.effort ?? null,
			duration_ms: r.duration_ms,
			status: r.status,
			cursor_calls_avoided: r.cursor_calls_avoided,
			"usage.input_tokens": r.usage?.input_tokens ?? null,
			"usage.output_tokens": r.usage?.output_tokens ?? null,
			"usage.total_tokens": r.usage?.total_tokens ?? null,
			"cost_usd": "UNKNOWN",
			"route.predicted": route?.predicted ?? null,
			"route.selected": route?.selected ?? "AGY_RESEARCH",
			"route.shadow_only": route?.shadow_only ?? true,
		},
		ts: Date.now(),
	};
}

export function emitImplementEvent(r: WorkReceipt, route?: RoutingDecision): AgyTokenomicsEvent {
	return {
		kind: "executor",
		name: "omp.agy.implementation",
		status: r.status === "ok" ? "ok" : "error",
		service: "agy",
		role: "implementation",
		attributes: {
			service: "agy",
			role: "implementation",
			task_id: r.task_id,
			conversation_id: r.conversation_id,
			repo: r.repo,
			worktree: r.worktree,
			model: r.model ?? null,
			agent: r.agent ?? null,
			effort: r.effort ?? null,
			duration_ms: r.duration_ms,
			status: r.status,
			verifier_ok: r.verifier.ok,
			cursor_calls_avoided: r.cursor_calls_avoided,
			"usage.total_tokens": r.usage?.total_tokens ?? null,
			"cost_usd": "UNKNOWN",
			"route.predicted": route?.predicted ?? null,
			"route.selected": route?.selected ?? "AGY_IMPLEMENT",
		},
		ts: Date.now(),
	};
}

export function emitRouteEvent(route: RoutingDecision): AgyTokenomicsEvent {
	return {
		kind: "executor",
		name: "omp.agy.route",
		status: "ok",
		service: "omp",
		role: "router",
		attributes: {
			predicted: route.predicted,
			selected: route.selected,
			confidence: route.confidence,
			mode: route.mode,
			shadow_only: route.shadow_only,
			reason: route.reason,
		},
		ts: Date.now(),
	};
}

export function emitPressureEvent(p: ProviderPressureSnapshot): AgyTokenomicsEvent {
	return {
		kind: "context",
		name: "omp.agy.pressure",
		status: "ok",
		service: "omp",
		role: "router",
		attributes: {
			omp_active_sessions: p.omp_active_sessions ?? null,
			recent_429_or_rate_limit: p.recent_429_or_rate_limit,
			agy_ready: p.agy_ready,
			agy_busy: p.agy_busy,
			agy_failed: p.agy_failed,
			agy_queue_depth: p.agy_queue_depth,
			agy_recent_failures: p.agy_recent_failures,
		},
		ts: p.ts,
	};
}

export class TokenomicsSink {
	readonly events: AgyTokenomicsEvent[] = [];
	push(ev: AgyTokenomicsEvent): AgyTokenomicsEvent {
		this.events.push(ev);
		return ev;
	}
}
