/**
 * Deterministic visibility rules (P0). No Jev authority.
 *
 * LIVE — must remain model-critical if/when virtual is activated
 * RECEIPT — compact proof of completed work
 * EXTERNAL — raw body living in RLM; not in virtual packet body
 * ARCHIVED — superseded / stale; omit from virtual LIVE set
 */

import type { VisibilityClass } from "./schema.ts";

export interface VisibilityInput {
	kind:
		| "user_input"
		| "assistant"
		| "tool_result"
		| "plan"
		| "test_run"
		| "commit"
		| "benchmark"
		| "other";
	/** Tool/status signals for tool_result / test_run. */
	status?: "ok" | "error" | "running" | "unknown";
	/** True when a durable receipt / SHA already exists. */
	has_receipt?: boolean;
	/** True when a newer plan/generation superseded this item. */
	superseded?: boolean;
	/** Unresolved failure or in-flight causal state. */
	unresolved?: boolean;
	/** Verified commit SHA or verifier-backed result. */
	verified?: boolean;
	/** Raw body still required (no safe receipt yet). */
	raw_required?: boolean;
}

export function classifyVisibility(input: VisibilityInput): VisibilityClass {
	if (input.superseded) return "ARCHIVED";

	switch (input.kind) {
		case "user_input":
			return "LIVE";
		case "assistant":
			return input.superseded ? "ARCHIVED" : "EXTERNAL";
		case "plan":
			return input.superseded ? "ARCHIVED" : "LIVE";
		case "commit":
			return input.verified || input.has_receipt ? "RECEIPT" : "LIVE";
		case "benchmark":
			return input.has_receipt ? "RECEIPT" : input.unresolved ? "LIVE" : "EXTERNAL";
		case "test_run":
		case "tool_result": {
			if (input.unresolved || input.status === "error" || input.status === "running") {
				return "LIVE";
			}
			if (input.raw_required && !input.has_receipt) return "LIVE";
			if (input.has_receipt || input.verified) return "RECEIPT";
			return "EXTERNAL";
		}
		default:
			return input.unresolved ? "LIVE" : "EXTERNAL";
	}
}

/** Whether virtual context may drop the raw body (keep receipt/handle only). */
export function mayExternalizeRaw(visibility: VisibilityClass, unresolved: boolean): boolean {
	if (unresolved) return false;
	return visibility === "RECEIPT" || visibility === "EXTERNAL" || visibility === "ARCHIVED";
}
