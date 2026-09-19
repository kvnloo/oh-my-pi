import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	LIVE_RUNTIME_DEV_SENTINEL,
	LiveRuntimeSupervisor,
	fingerprintFile,
} from "@oh-my-pi/pi-coding-agent/live-runtime";

describe("self-mod live activation sentinel (P9)", () => {
	it("proves N → N+1 → N+2 via sentinel file edits and warm reboot", async () => {
		const sentinelPath = path.resolve(
			import.meta.dir,
			"../../src/live-runtime/dev-sentinel.ts",
		);
		const original = await Bun.file(sentinelPath).text();
		let generation = 1;
		let activePid = 10;
		const activations: number[] = [];

		const supervisor = new LiveRuntimeSupervisor({
			watchRoots: [],
			getActivePid: () => activePid,
			getGeneration: () => generation,
			isSessionBusy: () => false,
			waitForSafeBoundary: async () => {},
			validateCandidate: async () => ({ ok: true }),
			killProcess: async () => {},
			getSessionIdentity: async () => ({
				cwd: process.cwd(),
				session_id: "self-mod",
				composer_draft: "draft",
			}),
			spawnCandidate: async handoff => {
				const pid = activePid + 1;
				return {
					pid,
					ready: Promise.resolve({
						pid,
						generation: handoff.to_generation,
						session_id: "self-mod",
					}),
				};
			},
			onActivated: signal => {
				activations.push(signal.generation);
				generation = signal.generation;
				activePid = signal.pid;
			},
		});

		expect(LIVE_RUNTIME_DEV_SENTINEL).toContain("sentinel-v1");

		const v2 = original.replace("sentinel-v1", "sentinel-v2");
		await Bun.write(sentinelPath, v2);
		const fp2 = await fingerprintFile(sentinelPath);
		await supervisor.notifyCoreChange([sentinelPath]);
		expect(generation).toBe(2);
		expect(activations).toEqual([2]);

		const v3 = v2.replace("sentinel-v2", "sentinel-v3");
		await Bun.write(sentinelPath, v3);
		const fp3 = await fingerprintFile(sentinelPath);
		expect(fp3).not.toBe(fp2);
		await supervisor.notifyCoreChange([sentinelPath]);
		expect(generation).toBe(3);
		expect(activations).toEqual([2, 3]);

		await Bun.write(sentinelPath, original);
	});
});
