/**
 * Handsfree E2E isolation: when the harness exports OMP_E2E_MONITOR +
 * OMP_E2E_WORKSPACE (and optionally OMP_HANDSFREE_E2E_TOKEN), agent-side
 * Hyprland launches must land on that detached headless target instead of
 * the user's active monitor.
 */

export interface E2eIsolationTarget {
	monitor: string;
	workspace: string;
	token: string | null;
}

function readTrimmed(env: NodeJS.ProcessEnv, key: string): string | null {
	const raw = env[key];
	if (typeof raw !== "string") return null;
	const value = raw.trim();
	return value.length > 0 ? value : null;
}

/** Resolve the active E2E isolation target from process env (or an override map). */
export function readE2eIsolationTarget(env: NodeJS.ProcessEnv = process.env): E2eIsolationTarget | null {
	const monitor = readTrimmed(env, "OMP_E2E_MONITOR");
	const workspace = readTrimmed(env, "OMP_E2E_WORKSPACE");
	if (!monitor || !workspace) return null;
	return {
		monitor,
		workspace,
		token: readTrimmed(env, "OMP_HANDSFREE_E2E_TOKEN"),
	};
}

/** Env vars every gated child must inherit so the harness can prove ownership. */
export function e2eIsolationChildEnv(target: E2eIsolationTarget): Record<string, string> {
	const env: Record<string, string> = {
		OMP_E2E_MONITOR: target.monitor,
		OMP_E2E_WORKSPACE: target.workspace,
		OMP_HUD_E2E_NO_PIN: "1",
	};
	if (target.token) env.OMP_HANDSFREE_E2E_TOKEN = target.token;
	return env;
}

/**
 * Merge isolation env into a launch env bag. Caller-supplied keys win so tests
 * can override deliberately; isolation keys fill only when absent.
 */
export function mergeE2eIsolationEnv(
	base: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const target = readE2eIsolationTarget(env);
	if (!target) return { ...(base ?? {}) };
	return { ...e2eIsolationChildEnv(target), ...(base ?? {}) };
}

/**
 * Build `hl.dsp.exec_cmd(...)` that places `shellCommand` on the isolation
 * monitor/workspace without stealing focus.
 */
export function buildGatedHyprExecExpression(shellCommand: string, target: E2eIsolationTarget): string {
	const childEnv = e2eIsolationChildEnv(target);
	const assignment = Object.entries(childEnv)
		.map(([key, value]) => `${key}=${shellQuote(value)}`)
		.join(" ");
	const wrapped = `env ${assignment} ${shellCommand}`;
	return (
		`hl.dsp.exec_cmd(${JSON.stringify(wrapped)}, ` +
		`{ workspace = "name:${luaString(target.workspace)}", ` +
		`monitor = "${luaString(target.monitor)}", no_initial_focus = true })`
	);
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9._/=+-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function luaString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
