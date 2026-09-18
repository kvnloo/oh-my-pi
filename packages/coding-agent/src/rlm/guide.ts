/**
 * RLM runtime guide — appended *after* the stable system prompt so prompt-cache
 * bytes of the base prompt stay unchanged (RFC #12400). Never rewrite the base.
 */
import runtimeGuide from "./prompts/runtime-guide.md" with { type: "text" };

export const RLM_RUNTIME_GUIDE = runtimeGuide.trim();

const GUIDE_MARKER = "RLM context engine is on for this session";

/**
 * Returns a new array: base segments + runtime guide when enabled.
 * Does not mutate `base`. Idempotent if the guide is already present.
 */
export function appendRlmRuntimeGuide(base: readonly string[], enabled: boolean): string[] {
	const copy = [...base];
	if (!enabled) return copy;
	if (copy.some(part => part.includes(GUIDE_MARKER))) return copy;
	copy.push(RLM_RUNTIME_GUIDE);
	return copy;
}

/** True when `next` only appends the RLM guide (or is identical) relative to `base`. */
export function rlmGuideIsAppendOnly(base: readonly string[], next: readonly string[]): boolean {
	if (next.length < base.length) return false;
	for (let i = 0; i < base.length; i++) {
		if (next[i] !== base[i]) return false;
	}
	if (next.length === base.length) return true;
	return next.length === base.length + 1 && (next[base.length]?.includes(GUIDE_MARKER) ?? false);
}
