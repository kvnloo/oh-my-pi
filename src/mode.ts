/**
 * Explicit cognitive-state provider modes.
 * Default: shadow. Canary requires explicit opt-in.
 */

export type CognitiveStateMode = "off" | "shadow" | "canary";

export type ContextMode = "native" | "virtual" | "virtual_fallback_native";

export interface CognitiveStateConfig {
	mode: CognitiveStateMode;
	/** Operator/config must set true for canary (defense in depth). */
	canary_opt_in: boolean;
	/** Allowlist of safe task classes for canary. */
	allowed_task_classes: readonly string[];
	/** Max one native fallback retry per user turn. */
	max_fallback_retries: 1;
}

export const DEFAULT_ALLOWED_TASK_CLASSES = [
	"repository_inspection",
	"targeted_code_edit",
	"tests",
	"git_status_diff",
	"branch_state_analysis",
	"deterministic_debugging",
] as const;

export const DEFAULT_CONFIG: CognitiveStateConfig = {
	mode: "shadow",
	canary_opt_in: false,
	allowed_task_classes: DEFAULT_ALLOWED_TASK_CLASSES,
	max_fallback_retries: 1,
};

export function parseMode(raw: unknown): CognitiveStateMode {
	const v = String(raw ?? "").trim().toLowerCase();
	if (v === "off" || v === "shadow" || v === "canary") return v;
	return "shadow";
}

/**
 * Resolve mode from explicit config + env.
 * Canary only activates when mode=canary AND opt-in is true.
 */
export function resolveConfig(partial?: Partial<CognitiveStateConfig> & {
	env?: Record<string, string | undefined>;
}): CognitiveStateConfig {
	const env = partial?.env ?? (typeof process !== "undefined" ? process.env : {});
	const modeFromEnv = parseMode(env.OMP_COGNITIVE_STATE_MODE ?? env.COGNITIVE_STATE_MODE);
	const optInEnv = /^(1|true|yes|on)$/i.test(
		String(env.OMP_COGNITIVE_STATE_CANARY_OPT_IN ?? env.COGNITIVE_STATE_CANARY_OPT_IN ?? ""),
	);
	const mode = partial?.mode ?? modeFromEnv;
	const canary_opt_in = partial?.canary_opt_in ?? optInEnv;
	return {
		mode,
		canary_opt_in,
		allowed_task_classes: partial?.allowed_task_classes ?? DEFAULT_ALLOWED_TASK_CLASSES,
		max_fallback_retries: 1,
	};
}

/** Effective runtime mode after opt-in gate. */
export function effectiveMode(cfg: CognitiveStateConfig): CognitiveStateMode {
	if (cfg.mode === "canary" && !cfg.canary_opt_in) return "shadow";
	return cfg.mode;
}

export function isCanaryActive(cfg: CognitiveStateConfig): boolean {
	return effectiveMode(cfg) === "canary";
}
