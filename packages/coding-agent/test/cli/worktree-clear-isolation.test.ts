import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearWorktrees } from "@oh-my-pi/pi-coding-agent/cli/worktree-cli";
import { ISOLATION_OWNER_FILE, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import { setWorktreesDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for #6761: `omp worktree clear` (no `--all`) must delete only
 * task-isolation sandboxes whose owner process is gone. A sandbox owned by a
 * live omp process holds a running subagent's uncaptured work and must survive.
 */
describe("worktree clear task-isolation ownership", () => {
	let base: string;
	let savedEnv: string | undefined;

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-clear-"));
		savedEnv = process.env.OMP_WORKTREE_DIR;
		delete process.env.OMP_WORKTREE_DIR;
		setWorktreesDir(base);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(async () => {
		setWorktreesDir(undefined);
		if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
		else process.env.OMP_WORKTREE_DIR = savedEnv;
		vi.restoreAllMocks();
		await fs.rm(base, { recursive: true, force: true });
	});

	async function makeSandbox(name: string): Promise<string> {
		const dir = path.join(base, name);
		await fs.mkdir(path.join(dir, "m"), { recursive: true });
		await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");
		return dir;
	}

	/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
	async function deadPid(): Promise<number> {
		const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.pid;
	}

	it("keeps live-owned sandboxes and reclaims dead/markerless/corrupt ones", async () => {
		const live = await makeSandbox("tlive0001");
		await writeIsolationOwner(live, "live0001"); // marker names this test process

		const dead = await makeSandbox("tdead0002");
		await Bun.write(path.join(dead, ISOLATION_OWNER_FILE), JSON.stringify({ pid: await deadPid(), id: "dead0002" }));

		const orphan = await makeSandbox("tnone0003"); // no marker at all (crashed pre-marker run)

		const corrupt = await makeSandbox("tbad00004");
		await Bun.write(path.join(corrupt, ISOLATION_OWNER_FILE), "{ not json");

		// Setup race: marker written before the backend materialises `m`. The
		// dir holds only the live-owner marker and no mount yet.
		const pending = path.join(base, "tpend0005");
		await fs.mkdir(pending, { recursive: true });
		await writeIsolationOwner(pending, "pend0005");

		// Recycled pid: the crashed owner's pid was reassigned to this live test
		// process, but the recorded start-time token no longer matches.
		const recycled = await makeSandbox("trecyc06");
		await Bun.write(
			path.join(recycled, ISOLATION_OWNER_FILE),
			JSON.stringify({ pid: process.pid, id: "recyc06", startToken: "not-the-current-token" }),
		);

		await clearWorktrees({ all: false, dryRun: false, json: true });

		const exists = async (p: string): Promise<boolean> =>
			await fs.stat(p).then(
				() => true,
				() => false,
			);
		expect(await Bun.file(path.join(live, "m", "work.txt")).exists()).toBe(true);
		expect(await exists(dead)).toBe(false);
		expect(await exists(orphan)).toBe(false);
		expect(await exists(corrupt)).toBe(false);
		expect(await exists(pending)).toBe(true);
		expect(await exists(recycled)).toBe(false);
	});
});

/**
 * Regression for the locale-divergence bug on non-Linux Unix (macOS/BSD):
 * `processStartToken` shells out to `ps -o lstart=`, whose output is formatted
 * via the locale-dependent `strftime("%c")`. When the owning omp process and a
 * later `omp worktree clear` run under different `LC_TIME`/`LC_ALL`, the
 * recomputed start-time token differs from the recorded one even though the pid
 * is still alive, so `hasLiveIsolationOwner` returns `false` and `clear` deletes
 * a live subagent's sandbox mid-flight. The fix pins `LC_ALL=C` on the `ps`
 * spawn (via `$.env({ ...Bun.env, LC_ALL: "C" })`) so the token is deterministic
 * across invocations.
 *
 * On Linux `processStartToken` reads `/proc/<pid>/stat` field 22 (numeric,
 * locale-free) and never reaches `ps`, so this test forces the `ps` branch via
 * a `process.platform` override. The fake `ps` is a *compiled ELF binary* that
 * prints `getenv("LC_ALL")` — not a `#!/bin/sh` script — because Bun's `$`
 * shell-template env prefix (`LC_ALL=C ps …`) does NOT override an inherited
 * `LC_ALL` for an ELF target the way it does for a shell-script target, so a
 * shell-script shim would mask a regression to the (broken-on-real-`ps`) prefix
 * form. The ELF shim reproduces the real `ps` env behaviour, so this test fails
 * under both the original no-pin bug and a prefix-form regression, and passes
 * only under the `.env()` fix. Gated on a C compiler (skipped otherwise).
 */
const FAKE_PS_ELF: string | null = (() => {
	if (process.platform === "win32") return null;
	let dir: string;
	try {
		dir = Bun.spawnSync(["mktemp", "-d"]).stdout.toString().trim();
	} catch {
		return null;
	}
	if (!dir) return null;
	const src = path.join(dir, "fakeps.c");
	const out = path.join(dir, "fakeps.elf");
	try {
		fsSync.writeFileSync(
			src,
			'#include <stdlib.h>\n#include <stdio.h>\nint main(void){const char* e=getenv("LC_ALL");printf("%s start\\n",e?e:"");return 0;}\n',
		);
		const cc = Bun.spawnSync(["cc", "-O2", "-o", out, src], { stdout: "ignore", stderr: "ignore" });
		if (cc.exitCode !== 0) return null;
		return out;
	} catch {
		return null;
	}
})();

describe.skipIf(process.platform === "win32" || FAKE_PS_ELF === null)(
	"worktree clear keeps a live sandbox across locales (ps branch)",
	() => {
		let base: string;
		let binDir: string | undefined;
		let originalPath: string | undefined;
		let savedEnv: string | undefined;
		let savedLCAll: string | undefined;
		let savedLang: string | undefined;
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

		beforeEach(async () => {
			base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wt-locale-"));
			binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-ps-"));
			savedEnv = process.env.OMP_WORKTREE_DIR;
			savedLCAll = process.env.LC_ALL;
			savedLang = process.env.LANG;
			originalPath = process.env.PATH;
			delete process.env.OMP_WORKTREE_DIR;

			// Force the non-Linux (`ps`) branch of `processStartToken` regardless of
			// host platform so the fix's `LC_ALL=C` pin is actually exercised.
			Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

			// ELF fake `ps`: prints `getenv("LC_ALL") + " start"`, mirroring how a
			// real `ps` reads its exec env (so the test sees the real prefix-vs-`.env`
			// distinction, not Bun's shell-script special-casing).
			await fs.copyFile(FAKE_PS_ELF!, path.join(binDir, "ps"));
			process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
			setWorktreesDir(base);
			vi.spyOn(console, "log").mockImplementation(() => {});
		});

		afterEach(async () => {
			setWorktreesDir(undefined);
			if (savedEnv === undefined) delete process.env.OMP_WORKTREE_DIR;
			else process.env.OMP_WORKTREE_DIR = savedEnv;
			if (savedLCAll === undefined) delete process.env.LC_ALL;
			else process.env.LC_ALL = savedLCAll;
			if (savedLang === undefined) delete process.env.LANG;
			else process.env.LANG = savedLang;
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
			vi.restoreAllMocks();
			if (binDir) await fs.rm(binDir, { recursive: true, force: true });
			await fs.rm(base, { recursive: true, force: true });
		});

		it("keeps a live sandbox whose owner marker was written under a different LC_TIME", async () => {
			const dir = path.join(base, "tlover01");
			await fs.mkdir(path.join(dir, "m"), { recursive: true });
			await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");

			// Marker written by an omp process running under a non-English locale.
			// Before the fix this records a locale-tagged token; after the fix the
			// token is pinned to the C locale regardless of caller env.
			process.env.LC_ALL = "fr_FR.UTF-8";
			process.env.LANG = "fr_FR.UTF-8";
			await writeIsolationOwner(dir, "lover01");

			// Clear invoked from a shell running under the POSIX/C locale. Before
			// the fix the recomputed token diverges and the live sandbox is deleted;
			// after the fix both produce the C-locale token and the sandbox survives.
			process.env.LC_ALL = "C";
			process.env.LANG = "C";
			await clearWorktrees({ all: false, dryRun: false, json: true });

			expect(await Bun.file(path.join(dir, "m", "work.txt")).exists()).toBe(true);
			expect(
				await fs.stat(path.join(dir, ISOLATION_OWNER_FILE)).then(
					() => true,
					() => false,
				),
			).toBe(true);
		});

		it("still reclaims a sandbox whose recorded token mismatches the live process", async () => {
			// The locale pin must not collapse the token compare into a vacuous
			// always-match: a recorded token the live process does not present is a
			// recycled pid and is still reclaimed on the `ps` branch.
			const dir = path.join(base, "trecyc02");
			await fs.mkdir(path.join(dir, "m"), { recursive: true });
			await Bun.write(path.join(dir, "m", "work.txt"), "uncaptured\n");
			await Bun.write(
				path.join(dir, ISOLATION_OWNER_FILE),
				JSON.stringify({ pid: process.pid, id: "recyc02", startToken: "not-the-current-token" }),
			);

			await clearWorktrees({ all: false, dryRun: false, json: true });

			expect(
				await fs.stat(path.join(dir, "m", "work.txt")).then(
					() => true,
					() => false,
				),
			).toBe(false);
		});
	},
);
