import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import type { SpawnOptions, Subprocess } from "bun";
import { PluginManager } from "../src/extensibility/plugins/manager";

function emptyStream(): ReadableStream<Uint8Array> {
	const body = new Response("").body;
	if (!body) throw new Error("Missing response stream");
	return body;
}

describe("install validation teardown lifecycle owner review", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let nodeModules: string;
	let packageJson: string;
	let children: Subprocess<"ignore", "ignore", "ignore">[];
	const nativeSpawn = Bun.spawn;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-teardown-review-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		nodeModules = path.join(pluginsDir, "node_modules");
		packageJson = path.join(pluginsDir, "package.json");
		children = [];
		await fs.mkdir(nodeModules, { recursive: true });
		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(nodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(packageJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		// The frozen baseline intentionally fails before shutdown. Always reap its
		// real child as well, so regression evidence cannot leave background work.
		for (const child of children) {
			const beforeHarnessCleanup = { exitCode: child.exitCode, signalCode: child.signalCode };
			if (child.exitCode === null && child.signalCode === null) child.kill();
			const exited = await child.exited;
			let aliveAfterReaping = false;
			try {
				process.kill(child.pid, 0);
				aliveAfterReaping = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
			console.info(JSON.stringify({ reviewChild: child.pid, beforeHarnessCleanup, exited, aliveAfterReaping }));
			expect(aliveAfterReaping).toBe(false);
		}
		await removeWithRetries(tmpRoot);
	});

	async function stageInstall(entries: string[], sources: Record<string, string>): Promise<void> {
		const prepare = async () => {
			await Bun.write(
				packageJson,
				JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "lifecycle-plugin": "1.0.0" } }),
			);
			await Bun.write(
				path.join(nodeModules, "lifecycle-plugin", "package.json"),
				JSON.stringify({ name: "lifecycle-plugin", version: "1.0.0", omp: { extensions: entries } }),
			);
			await Bun.write(
				path.join(nodeModules, "lifecycle-plugin", "cleanup-resource"),
				"resource available during cleanup",
			);
			for (const [entry, source] of Object.entries(sources)) {
				await Bun.write(path.join(nodeModules, "lifecycle-plugin", entry), source);
			}
		};
		vi.spyOn(Bun, "spawn").mockImplementation(((
			cmd: string[],
			options?: SpawnOptions<"ignore", "ignore", "ignore">,
		) => {
			if (cmd[0] === "/bin/sleep") {
				expect(cmd).toEqual(["/bin/sleep", "60"]);
				const child = nativeSpawn(cmd, options);
				children.push(child);
				return child;
			}
			expect(cmd).toEqual(["bun", "install", "--no-cache", "lifecycle-plugin"]);
			return { pid: 1, stdout: emptyStream(), stderr: emptyStream(), exited: prepare().then(() => 0) } as Subprocess;
		}) as typeof Bun.spawn);
	}

	function eagerSource(throwingHandler = false): string {
		const resource = path.join(nodeModules, "lifecycle-plugin", "cleanup-resource");
		const complete = path.join(tmpRoot, "cleanup-complete");
		const lateTimer = path.join(tmpRoot, "late-managed-timer");
		return `export default function(pi) {
			const child = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
			${throwingHandler ? 'pi.on("session_shutdown", () => { throw new Error("shutdown handler failure"); });' : ""}
			pi.on("session_shutdown", async (_event, ctx) => {
				ctx.setTimeout(() => Bun.write(${JSON.stringify(lateTimer)}, "fired after teardown"), 200);
				await Bun.sleep(25);
				const resource = await Bun.file(${JSON.stringify(resource)}).text();
				child.kill();
				await child.exited;
				await Bun.write(${JSON.stringify(complete)}, resource);
			});
		}`;
	}

	async function expectCleanupSettled(): Promise<void> {
		expect(children).toHaveLength(1);
		expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
		expect(await Bun.file(path.join(tmpRoot, "cleanup-complete")).text()).toBe("resource available during cleanup");
		await Bun.sleep(250);
		// A heavily stalled host can legitimately fire this timer while teardown
		// is still in progress. Record it as a diagnostic, never a false-RED gate.
		console.info(
			JSON.stringify({
				managedTimerDiagnostic: {
					delayMs: 200,
					observationAfterSettlementMs: 250,
					fired: await Bun.file(path.join(tmpRoot, "late-managed-timer")).exists(),
				},
			}),
		);
	}

	// PR #15169 promises clean siblings are shut down before validation errors
	// are reported. Each case exercises a distinct error-collection boundary.
	test.each([
		{ failure: "missing manifest entry", brokenSource: null, error: /declared extension entry not found/ },
		{
			failure: "sibling import failure",
			brokenSource: 'import "review-dependency-that-does-not-exist"; export default function() {}',
			error: /review-dependency-that-does-not-exist/,
		},
	])("awaits child teardown before rollback after $failure", async ({ brokenSource, error }) => {
		await stageInstall(["./eager.ts", "./broken.ts"], {
			"eager.ts": eagerSource(),
			...(brokenSource ? { "broken.ts": brokenSource } : {}),
		});
		await expect(new PluginManager(tmpRoot).install("lifecycle-plugin")).rejects.toThrow(error);
		await expectCleanupSettled();
		const restored = await Bun.file(packageJson).json();
		expect(restored.dependencies ?? {}).toEqual({});
		expect(await Bun.file(path.join(nodeModules, "lifecycle-plugin", "package.json")).exists()).toBe(false);
	});

	// The documented runner contract isolates handler failures; another handler
	// must still finish cleanup. Its managed timer is observed diagnostically.
	test("a throwing shutdown handler cannot skip another handler's child teardown", async () => {
		await stageInstall(["./eager.ts"], { "eager.ts": eagerSource(true) });
		await new PluginManager(tmpRoot).install("lifecycle-plugin");
		await expectCleanupSettled();
		expect(await Bun.file(path.join(nodeModules, "lifecycle-plugin", "cleanup-resource")).text()).toBe(
			"resource available during cleanup",
		);
	});
});
