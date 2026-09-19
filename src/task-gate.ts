/**
 * Safe task-class gate for canary. Deterministic keyword heuristics only.
 */

import type { CognitiveStateConfig } from "./mode.ts";

export type TaskClass =
	| "repository_inspection"
	| "targeted_code_edit"
	| "tests"
	| "git_status_diff"
	| "branch_state_analysis"
	| "deterministic_debugging"
	| "destructive"
	| "credentials_security"
	| "release_deploy"
	| "ambiguous_intent"
	| "large_unresolved_raw"
	| "other";

const BLOCKED: TaskClass[] = [
	"destructive",
	"credentials_security",
	"release_deploy",
	"ambiguous_intent",
	"large_unresolved_raw",
];

export interface TaskGateInput {
	user_text: string;
	has_unresolved_error?: boolean;
	unresolved_raw_bytes?: number;
	explicit_class?: TaskClass;
}

export interface TaskGateResult {
	task_class: TaskClass;
	allowed: boolean;
	reason: string;
}

export function classifyTask(input: TaskGateInput): TaskClass {
	if (input.explicit_class) return input.explicit_class;
	const t = input.user_text.toLowerCase();
	if (/(rm\s+-rf|delete\s+prod|drop\s+table|force\s+push|git\s+push\s+--force)/i.test(t)) return "destructive";
	if (/(credential|secret|api[_\s-]?key|password|token\s+rotate|vault)/i.test(t)) return "credentials_security";
	if (/(release|deploy|publish|npm\s+publish|ship\s+to\s+prod)/i.test(t)) return "release_deploy";
	if ((input.unresolved_raw_bytes ?? 0) > 50_000 && input.has_unresolved_error) return "large_unresolved_raw";
	if (/\b(maybe|not sure|whatever|figure\s+something)\b/i.test(t) && t.length < 40) return "ambiguous_intent";
	if (/\b(test|pytest|bun test|jest|vitest)\b/i.test(t)) return "tests";
	if (/\b(git\s+status|git\s+diff|diff\b)/i.test(t)) return "git_status_diff";
	if (/\b(branch|worktree|rebase|merge\s+base)\b/i.test(t)) return "branch_state_analysis";
	if (/\b(edit|fix|patch|refactor)\b/i.test(t)) return "targeted_code_edit";
	if (/\b(inspect|read|locate|where\s+is|list\s+files|explore)\b/i.test(t)) return "repository_inspection";
	if (/\b(debug|hang|failing|stack\s*trace|repro)\b/i.test(t)) return "deterministic_debugging";
	return "other";
}

export function gateCanaryTask(cfg: CognitiveStateConfig, input: TaskGateInput): TaskGateResult {
	const task_class = classifyTask(input);
	if (BLOCKED.includes(task_class)) {
		return { task_class, allowed: false, reason: `blocked_task_class:${task_class}` };
	}
	if (!cfg.allowed_task_classes.includes(task_class)) {
		return { task_class, allowed: false, reason: `not_in_allowlist:${task_class}` };
	}
	return { task_class, allowed: true, reason: "allowlist_ok" };
}
