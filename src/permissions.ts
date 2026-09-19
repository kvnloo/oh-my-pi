/**
 * Per-worktree AGY permission profiles.
 * Never uses --dangerously-skip-permissions.
 *
 * Writes/merges into ~/.gemini/antigravity-cli/settings.json
 * (installed CLI has no --settings override flag).
 *
 * Everyday lane: AgyDriver calls withPermissions() so apply/restore is
 * crash-safe for success, denial, timeout, and thrown errors (finally).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface PermissionLists {
	allow: string[];
	deny: string[];
	ask: string[];
}

export interface AppliedPermissions {
	settings_path: string;
	backup_path: string;
	profile: PermissionLists;
	trusted_workspaces: string[];
	tag: string;
}

export interface PermissionScope {
	applied: boolean;
	restored: boolean;
	settings_path?: string;
	backup_path?: string;
	tag?: string;
	allow?: string[];
	deny?: string[];
}

const DEFAULT_SETTINGS = path.join(os.homedir(), ".gemini/antigravity-cli/settings.json");

/** Serialize global settings.json mutations across concurrent AGY turns. */
let permissionTail: Promise<unknown> = Promise.resolve();

const activeScopes = new Set<AppliedPermissions>();

function restoreAllActive(): void {
	for (const applied of [...activeScopes]) {
		try {
			restorePermissions(applied.backup_path, applied.settings_path);
		} catch {
			/* best-effort on process exit */
		}
		activeScopes.delete(applied);
	}
}

if (typeof process !== "undefined" && typeof process.on === "function") {
	process.on("exit", restoreAllActive);
}

export function researchPermissions(repoRoot: string): PermissionLists {
	const abs = path.resolve(repoRoot);
	const home = os.homedir();
	const pkg = path.resolve(path.join(import.meta.dir, ".."));
	return {
		allow: [
			`read_file(${abs})`,
			`read_file(${pkg})`,
			`read_file(${path.join(home, ".gemini/config/agents")})`,
			`read_file(${path.join(home, ".gemini/antigravity-cli")})`,
			"command(git status)",
			"command(git diff)",
			"command(git rev-parse)",
			"command(git log)",
			"command(git show)",
			"command(git ls-files)",
		],
		deny: [
			`write_file(${abs})`,
			`write_file(${path.join(home, ".ssh")})`,
			`write_file(${path.join(home, ".omp")})`,
			`write_file(${path.join(home, ".gemini/antigravity-cli/settings.json")})`,
			"command(git push)",
			"command(git reset)",
			"command(git clean)",
			"command(sudo)",
			"command(regex:rm\\s+-rf\\s+/)",
			`read_file(${path.join(home, ".ssh")})`,
			`read_file(${path.join(home, ".omp")})`,
		],
		ask: [],
	};
}

export function implementPermissions(worktree: string, parentRepo?: string): PermissionLists {
	const abs = path.resolve(worktree);
	const home = os.homedir();
	const pkg = path.resolve(path.join(import.meta.dir, ".."));
	const parent = parentRepo ? path.resolve(parentRepo) : "";
	return {
		allow: [
			`write_file(${abs})`,
			`read_file(${abs})`,
			...(parent && parent !== abs ? [`read_file(${parent})`] : []),
			`read_file(${pkg})`,
			`read_file(${path.join(home, ".gemini/config/agents")})`,
			`read_file(${path.join(home, ".gemini/antigravity-cli")})`,
			"command(git status)",
			"command(git diff)",
			"command(git rev-parse)",
			"command(git log)",
			"command(git show)",
			"command(git add)",
			"command(git commit)",
			"command(bun test)",
			"command(bun)",
			"command(regex:bun test.*)",
		],
		deny: [
			...(parent && parent !== abs ? [`write_file(${parent})`] : []),
			"command(git push)",
			"command(git reset --hard)",
			"command(git clean)",
			"command(sudo)",
			"command(regex:rm\\s+-rf\\s+/)",
			`write_file(${path.join(home, ".ssh")})`,
			`write_file(${path.join(home, ".omp")})`,
			`write_file(${path.join(home, ".gemini/antigravity-cli/settings.json")})`,
			`read_file(${path.join(home, ".ssh")})`,
		],
		ask: [],
	};
}

export function applyPermissions(opts: {
	profile: PermissionLists;
	trusted_workspaces?: string[];
	deny_write_paths?: string[];
	settings_path?: string;
	tag?: string;
}): AppliedPermissions {
	const settings_path = opts.settings_path ?? DEFAULT_SETTINGS;
	fs.mkdirSync(path.dirname(settings_path), { recursive: true });
	const tag = opts.tag ?? String(Date.now());
	const backup_path = `${settings_path}.bak-agy-${tag}`;
	let existing: Record<string, unknown> = {};
	if (fs.existsSync(settings_path)) {
		const raw = fs.readFileSync(settings_path, "utf8");
		fs.writeFileSync(backup_path, raw);
		try {
			existing = JSON.parse(raw);
		} catch {
			existing = {};
		}
	} else {
		fs.writeFileSync(backup_path, "{}\n");
	}

	const deny = [
		...opts.profile.deny,
		...(opts.deny_write_paths ?? []).map((p) => `write_file(${path.resolve(p)})`),
	];
	const trusted = Array.from(
		new Set([
			...((existing.trustedWorkspaces as string[] | undefined) ?? []),
			...(opts.trusted_workspaces ?? []),
		]),
	);

	const next = {
		...existing,
		trustedWorkspaces: trusted,
		permissions: {
			allow: opts.profile.allow,
			deny,
			ask: opts.profile.ask,
		},
	};
	fs.writeFileSync(settings_path, JSON.stringify(next, null, 2) + "\n");
	const applied: AppliedPermissions = {
		settings_path,
		backup_path,
		profile: { allow: opts.profile.allow, deny, ask: opts.profile.ask },
		trusted_workspaces: trusted,
		tag,
	};
	activeScopes.add(applied);
	return applied;
}

export function restorePermissions(backup_path: string, settings_path = DEFAULT_SETTINGS): void {
	if (!fs.existsSync(backup_path)) return;
	fs.copyFileSync(backup_path, settings_path);
	try {
		fs.unlinkSync(backup_path);
	} catch {
		/* leave backup if unlink fails */
	}
	for (const a of [...activeScopes]) {
		if (a.backup_path === backup_path) activeScopes.delete(a);
	}
}

/**
 * Apply a permission profile, run `fn`, always restore (success / throw / denial path).
 * Serialized so concurrent AGY turns do not clobber settings.json.
 */
export async function withPermissions<T>(
	opts: {
		profile: PermissionLists;
		trusted_workspaces?: string[];
		deny_write_paths?: string[];
		settings_path?: string;
		tag?: string;
	},
	fn: (applied: AppliedPermissions) => Promise<T> | T,
): Promise<{ result: T; scope: PermissionScope }> {
	const scope: PermissionScope = { applied: false, restored: false };
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const prev = permissionTail;
	permissionTail = prev.then(() => gate).catch(() => gate);
	await prev.catch(() => undefined);

	let applied: AppliedPermissions | null = null;
	try {
		applied = applyPermissions(opts);
		scope.applied = true;
		scope.settings_path = applied.settings_path;
		scope.backup_path = applied.backup_path;
		scope.tag = applied.tag;
		scope.allow = applied.profile.allow;
		scope.deny = applied.profile.deny;
		const result = await fn(applied);
		return { result, scope };
	} finally {
		try {
			if (applied) {
				restorePermissions(applied.backup_path, applied.settings_path);
				scope.restored = true;
			}
		} finally {
			release();
		}
	}
}
