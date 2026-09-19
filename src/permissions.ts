/**
 * Per-worktree AGY permission profiles.
 * Never uses --dangerously-skip-permissions.
 *
 * Writes/merges into ~/.gemini/antigravity-cli/settings.json
 * (installed CLI has no --settings override flag).
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
}

const DEFAULT_SETTINGS = path.join(os.homedir(), ".gemini/antigravity-cli/settings.json");

export function researchPermissions(repoRoot: string): PermissionLists {
	const abs = path.resolve(repoRoot);
	const home = os.homedir();
	const pkg = path.resolve(path.join(import.meta.dir, ".."));
	return {
		allow: [
			// AGY ViewFile confirmations match read_file(<dir-or-file>) rules.
			// Agent also reads its agent.md + schemas outside the target repo.
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
			// Parent is read-only context; AGY often opens the main checkout path first.
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
	const backup_path = `${settings_path}.bak-agy-p05-${opts.tag ?? Date.now()}`;
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
	return {
		settings_path,
		backup_path,
		profile: { allow: opts.profile.allow, deny, ask: opts.profile.ask },
		trusted_workspaces: trusted,
	};
}

export function restorePermissions(backup_path: string, settings_path = DEFAULT_SETTINGS): void {
	if (!fs.existsSync(backup_path)) return;
	fs.copyFileSync(backup_path, settings_path);
}
