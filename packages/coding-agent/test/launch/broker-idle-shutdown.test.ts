// Integration test — real timers are required (ts-no-test-timers exception): this drives the actual
// cross-process daemon broker running a real child process, and the bug is a missing idle-shutdown
// rearm in #settle. Fake timers cannot control the OS process-exit promise or the unix-socket RPC,
// and shutdown is observed by awaiting the broker's own run() promise — its resolution IS the signal
// (no polling, no fixed sleep). A regression leaves the broker alive, so the test's own timeout
// surfaces the failure.
//
// idleGraceMs is intentionally load-safer than the historical 100ms value (prod default is 3000ms).
// Under a warm singleton/global-state bucket, first connect+auth can miss a 100ms first-listen
// window and the broker idles out before start lands. Keep grace << prod, but high enough that
// suite load does not race the first-auth path. Daemon hold must still outlive grace so the first
// idle fire occurs while the persistent daemon is live — that is what forces #settle to rearm.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

/** Load-safe first-listen grace: ≫ historical 100ms flake window, ≪ prod 3000ms default. */
const IDLE_GRACE_MS = 1_000;
/** Must outlive IDLE_GRACE_MS so the first idle fire is a no-op and only #settle rearms. */
const DAEMON_HOLD_MS = 1_300;
/**
 * Artificial pre-auth stall past the old 100ms death window. Models singleton-bucket event-loop
 * lag between listen and first authenticated client without requiring the full 79-file harness.
 */
const PRE_AUTH_PRESSURE_MS = 250;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, idleGraceMs: number): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = String(idleGraceMs);
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPersistentIdleRearm(options: {
	idleGraceMs: number;
	daemonHoldMs: number;
	preAuthDelayMs?: number;
}): Promise<void> {
	using tempDir = TempDir.createSync("@omp-launch-idle-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);

	const previousTitle = process.title;
	// Create the client (writes broker.token) before starting the broker, which reads that token.
	const client = await createDaemonBrokerClient(projectDir, {
		runtimeDir,
		idleGraceMs: options.idleGraceMs,
	});
	const broker = startBroker(projectDir, runtimeDir, options.idleGraceMs);
	try {
		if (options.preAuthDelayMs && options.preAuthDelayMs > 0) {
			// Stall past the historical 100ms first-listen idle window before connect+auth.
			await delay(options.preAuthDelayMs);
		}

		// A persistent daemon that outlives the first idle-shutdown timer and then self-exits.
		// restart:"no" so its exit is terminal.
		const started = await client.request({
			op: "start",
			spec: {
				name: "persistent-temp",
				application: process.execPath,
				args: ["-e", `setTimeout(() => {}, ${options.daemonHoldMs})`],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: true,
				detached: false,
			},
		});
		expect(started.op).toBe("start");

		// Disconnect the final client. The broker keeps the persistent daemon alive, so the
		// idle timer this arms fires while the daemon is still live and returns without rearming.
		client.close();

		// When the daemon self-exits, terminal settlement must rearm idle shutdown; the broker
		// then releases its lease and run() resolves. Awaiting the broker promise IS the shutdown
		// signal. Before the fix nothing rearmed, so this await never resolved and the test timed
		// out — the regression this guards.
		await broker;
	} finally {
		process.title = previousTitle;
	}
}

describe("daemon broker idle shutdown", () => {
	it("shuts down after its last persistent daemon exits with no clients", async () => {
		await runPersistentIdleRearm({
			idleGraceMs: IDLE_GRACE_MS,
			daemonHoldMs: DAEMON_HOLD_MS,
		});
	}, 30_000);

	// Regression for the singleton/global-state bucket race: first connect+auth lag after listen
	// used to exceed idleGraceMs:100 and kill the broker before start landed. Keep grace at 1000
	// and inject pre-auth pressure past the old window, then still require #settle rearm.
	it("survives pre-auth pressure then rearms idle after persistent exit", async () => {
		await runPersistentIdleRearm({
			idleGraceMs: IDLE_GRACE_MS,
			daemonHoldMs: DAEMON_HOLD_MS,
			preAuthDelayMs: PRE_AUTH_PRESSURE_MS,
		});
	}, 30_000);
});
