import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface WorktreeHandle {
	repo: string;
	worktree: string;
	base_sha: string;
	branch: string;
}

function git(repo: string, args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

export function resolveRepoRoot(cwd = process.cwd()): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function createIsolatedWorktree(opts: {
	repo?: string;
	task_id: string;
	root?: string;
}): WorktreeHandle {
	const repo = path.resolve(opts.repo ?? resolveRepoRoot());
	const base_sha = git(repo, ["rev-parse", "HEAD"]);
	const short = createHash("sha1").update(opts.task_id).digest("hex").slice(0, 10);
	const root = opts.root ?? path.join(repo, ".agy-worktrees");
	fs.mkdirSync(root, { recursive: true });
	const worktree = path.join(root, `impl-${short}`);
	const branch = `agy/impl-${short}`;
	if (fs.existsSync(worktree)) {
		return { repo, worktree, base_sha: git(worktree, ["rev-parse", "HEAD"]), branch };
	}
	try {
		git(repo, ["worktree", "add", "-b", branch, worktree, "HEAD"]);
	} catch {
		// branch may exist
		git(repo, ["worktree", "add", worktree, branch]);
	}
	return { repo, worktree, base_sha, branch };
}

export function worktreeStatus(worktree: string): {
	head_sha: string;
	changed_files: string[];
	dirty: boolean;
} {
	const head_sha = git(worktree, ["rev-parse", "HEAD"]);
	const changed = git(worktree, ["status", "--porcelain"])
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.map((l) => l.replace(/^\S+\s+/, ""));
	return { head_sha, changed_files: changed, dirty: changed.length > 0 };
}

export function parentCheckoutUntouched(repo: string, base_sha: string): boolean {
	const head = git(repo, ["rev-parse", "HEAD"]);
	const dirty = git(repo, ["status", "--porcelain"]).trim().length > 0;
	// Parent HEAD must remain at base; dirty parent from pre-existing state is allowed
	// as long as we didn't move HEAD. We only require HEAD unchanged.
	void dirty;
	return head === base_sha;
}
