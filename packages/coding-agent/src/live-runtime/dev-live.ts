#!/usr/bin/env bun
/**
 * Supervised warm-reboot development entrypoint.
 * Usage: bun run dev:live  (from packages/coding-agent)
 *        or: bun packages/coding-agent/src/live-runtime/dev-live.ts
 *
 * Child OMP owns session work. Supervisor owns watch/validate/swap.
 */

import * as path from "node:path";
import { $ } from "bun";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { logger } from "@oh-my-pi/pi-utils";
import {
	LiveRuntimeSupervisor,
	classifyChangeTier,
	listRuntimeRegistry,
	resolveCoreIdentity,
	writeHandoffFile,
	type WarmRebootHandoff,
} from "./index";

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const handoffPath = path.join(repoRoot, "tmp", "live-runtime-handoff.json");
const cliEntry = path.join(repoRoot, "packages/coding-agent/src/cli.ts");
const codingAgentDir = path.join(repoRoot, "packages/coding-agent");

const watchRoots = [
	path.join(repoRoot, "packages/coding-agent/src"),
	path.join(repoRoot, "packages/tui/src"),
	path.join(repoRoot, "packages/ai/src"),
	path.join(repoRoot, "packages/utils/src"),
];

let child: ReturnType<typeof Bun.spawn> | undefined;
let generation = 1;
let activePid = 0;
let busy = false;

async function spawnChild(handoff?: WarmRebootHandoff): Promise<ReturnType<typeof Bun.spawn>> {
	if (handoff) await writeHandoffFile(handoffPath, handoff);
	const resumeArgs: string[] = [];
	if (handoff?.session_id && handoff.session_id !== "dev-live") {
		resumeArgs.push("--resume", handoff.session_id);
	}
	const args = ["run", cliEntry, ...resumeArgs, ...process.argv.slice(2)];
	const proc = Bun.spawn(["bun", ...args], {
		cwd: process.cwd(),
		stdout: "inherit",
		stderr: "inherit",
		stdin: "inherit",
		env: {
			...process.env,
			OMP_LIVE_RUNTIME_GENERATION: String(handoff?.to_generation ?? generation),
			OMP_LIVE_RUNTIME_HANDOFF: handoff ? handoffPath : "",
			OMP_LIVE_RUNTIME_SUPERVISED: "1",
		},
	});
	activePid = proc.pid;
	child = proc;
	return proc;
}

const supervisor = new LiveRuntimeSupervisor({
	watchRoots,
	debounceMs: 250,
	getActivePid: () => activePid,
	getGeneration: () => generation,
	isSessionBusy: () => busy,
	waitForSafeBoundary: async () => {
		while (busy) await Bun.sleep(100);
	},
	validateCandidate: async () => {
		// Cheap syntax/bundle gate (plan). Full `bun check` fails on pre-existing lint.
		const outdir = path.join(repoRoot, "tmp", "live-runtime-validate-build");
		const check = await $`bun build ${cliEntry} --outdir=${outdir} --target=bun --packages=external`
			.cwd(codingAgentDir)
			.nothrow()
			.quiet();
		if (check.exitCode !== 0) {
			return {
				ok: false,
				failure_reason: check.stderr.toString().slice(0, 400) || check.stdout.toString().slice(0, 400) || "bun build failed",
			};
		}
		return { ok: true };
	},
	killProcess: async pid => {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			/* already gone */
		}
	},
	getSessionIdentity: async () => {
		const core = await resolveCoreIdentity({ version: VERSION, source_root: repoRoot });
		const entries = await listRuntimeRegistry();
		const match =
			entries.find(e => e.pid === activePid) ??
			entries.find(e => e.cwd === process.cwd()) ??
			entries.at(-1);
		return {
			cwd: match?.cwd ?? process.cwd(),
			session_id: match?.session_id ?? process.env.OMP_SESSION_ID ?? "dev-live",
			core_sha_before: match?.core_sha ?? core.git_sha,
		};
	},
	spawnCandidate: async handoff => {
		const proc = await spawnChild(handoff);
		const ready = (async () => {
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline) {
				if (proc.exitCode !== null) throw new Error(`candidate exited early: ${proc.exitCode}`);
				const entries = await listRuntimeRegistry();
				const hit = entries.find(e => e.pid === proc.pid);
				if (hit) {
					return {
						pid: proc.pid,
						generation: handoff.to_generation,
						session_id: hit.session_id,
						core_sha: hit.core_sha ?? handoff.core_sha_before,
					};
				}
				await Bun.sleep(150);
			}
			throw new Error("candidate ready timeout waiting for registry entry");
		})();
		return { pid: proc.pid, ready };
	},
	onStatus: message => {
		console.error(`[dev-live] ${message}`);
	},
	onActivated: (signal, metrics) => {
		generation = signal.generation;
		activePid = signal.pid;
		console.error(
			`[dev-live] activated generation ${signal.generation} pid=${signal.pid} total_ms=${metrics.total_ms}`,
		);
	},
	onRejected: (reason, metrics) => {
		console.error(`[dev-live] rejected: ${reason} (validate_ms=${metrics.validate_ms})`);
	},
});

// Intercept file-change classification: Tier A would request /runtime reload in a
// fuller integration; this MVP routes core allowlist paths through warm reboot.
const originalNotify = supervisor.notifyCoreChange.bind(supervisor);
supervisor.notifyCoreChange = async (files: string[]) => {
	const tier = classifyChangeTier(files);
	if (tier === "A") {
		console.error(`[dev-live] Tier A change detected — request /runtime reload in-session`);
		return;
	}
	await originalNotify(files);
};

child = await spawnChild();
generation = 1;
await supervisor.start();
logger.info("dev-live supervisor started", { pid: activePid, generation, version: VERSION });

// Stay alive across warm reboots: only exit when the current child exits without replacement.
for (;;) {
	const current = child;
	if (!current) break;
	const exitCode = await current.exited;
	if (child !== current) continue;
	await supervisor.stop();
	process.exit(exitCode);
}
