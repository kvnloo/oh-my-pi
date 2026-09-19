/**
 * Shadow-only executor routing (manual/shadow-auto). No authority in P0.
 */
import type { ExecutorLane, ExecutorMode, RoutingDecision, ProviderPressureSnapshot } from "./types.ts";

export interface RouteFeatures {
	requires_writes: boolean;
	research_heavy: boolean;
	verifier_available: boolean;
	repo_dirty: boolean;
	destructive_risk: boolean;
	provider_pressure: number;
	active_omp_sessions: number;
	recent_429: number;
	agy_ready: boolean;
	agy_queue_depth: number;
	estimated_duration_s: number;
	worktree_available: boolean;
	prompt: string;
}

export function extractFeatures(prompt: string, pressure?: Partial<ProviderPressureSnapshot>): RouteFeatures {
	const t = prompt.toLowerCase();
	const requires_writes = /\b(implement|fix|edit|patch|write|refactor|add)\b/.test(t);
	const research_heavy = /\b(research|investigate|why|analyze|survey|compare|hypothesis)\b/.test(t);
	const destructive_risk = /\b(rm\s+-rf|force\s+push|drop\s+table|deploy|credential|secret)\b/.test(t);
	return {
		requires_writes,
		research_heavy,
		verifier_available: /\b(test|pytest|bun test|verifier)\b/.test(t),
		repo_dirty: false,
		destructive_risk,
		provider_pressure: pressure?.recent_429_or_rate_limit ?? 0,
		active_omp_sessions: pressure?.omp_active_sessions ?? 1,
		recent_429: pressure?.recent_429_or_rate_limit ?? 0,
		agy_ready: (pressure?.agy_ready ?? 1) > 0,
		agy_queue_depth: pressure?.agy_queue_depth ?? 0,
		estimated_duration_s: requires_writes ? 120 : 45,
		worktree_available: true,
		prompt,
	};
}

/** Deterministic shadow predictor (stand-in until resident Jev is wired). */
export function predictLane(features: RouteFeatures): { lane: ExecutorLane; confidence: number; reason: string } {
	if (features.destructive_risk) {
		return { lane: "OMP_ROOT", confidence: 0.9, reason: "destructive_risk_keep_omp" };
	}
	if (features.research_heavy && !features.requires_writes) {
		return { lane: "AGY_RESEARCH", confidence: 0.82, reason: "research_heavy_read_only" };
	}
	if (features.requires_writes && features.worktree_available && features.agy_ready) {
		const conf = features.recent_429 > 0 ? 0.88 : 0.7;
		return { lane: "AGY_IMPLEMENT", confidence: conf, reason: features.recent_429 > 0 ? "writes_under_provider_pressure" : "writes_isolated_wt" };
	}
	if (features.recent_429 > 0 && features.research_heavy) {
		return { lane: "AGY_RESEARCH", confidence: 0.75, reason: "pressure_divert_research" };
	}
	return { lane: "OMP_ROOT", confidence: 0.55, reason: "default_omp_root" };
}

export function shadowDecision(
	prompt: string,
	selected: ExecutorLane,
	mode: ExecutorMode,
	pressure?: Partial<ProviderPressureSnapshot>,
): RoutingDecision {
	const features = extractFeatures(prompt, pressure);
	const pred = predictLane(features);
	return {
		predicted: pred.lane,
		selected,
		confidence: pred.confidence,
		mode,
		reason: pred.reason,
		features: {
			requires_writes: features.requires_writes,
			research_heavy: features.research_heavy,
			destructive_risk: features.destructive_risk,
			recent_429: features.recent_429,
			agy_ready: features.agy_ready,
			estimated_duration_s: features.estimated_duration_s,
		},
		shadow_only: mode !== "auto",
	};
}
