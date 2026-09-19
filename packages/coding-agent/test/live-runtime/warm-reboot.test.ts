import { describe, expect, it } from "bun:test";
import {
	LiveRuntimeSupervisor,
	classifyChangeTier,
	type CandidateReadySignal,
	type WarmRebootHandoff,
} from "@oh-my-pi/pi-coding-agent/live-runtime";

describe("warm reboot supervisor (P7)", () => {
	it("swaps only after READY; old pid killed after candidate ready", async () => {
		let activePid = 100;
		let generation = 1;
		const killed: number[] = [];
		let activated: CandidateReadySignal | undefined;

		const supervisor = new LiveRuntimeSupervisor({
			watchRoots: [],
			getActivePid: () => activePid,
			getGeneration: () => generation,
			isSessionBusy: () => false,
			waitForSafeBoundary: async () => {},
			validateCandidate: async () => ({ ok: true }),
			killProcess: async pid => {
				killed.push(pid);
			},
			getSessionIdentity: async () => ({
				cwd: "/tmp",
				session_id: "s1",
				session_path: "/tmp/s1.jsonl",
				model: "test/model",
				thinking_level: "medium",
				composer_draft: "hello",
			}),
			spawnCandidate: async (handoff: WarmRebootHandoff) => {
				const pid = 200;
				return {
					pid,
					ready: Promise.resolve({
						pid,
						generation: handoff.to_generation,
						session_id: handoff.session_id,
						core_sha: "abc",
					}),
				};
			},
			onActivated: signal => {
				activated = signal;
				activePid = signal.pid;
				generation = signal.generation;
			},
		});

		await supervisor.notifyCoreChange(["/repo/packages/coding-agent/src/cli.ts"]);
		expect(activated?.pid).toBe(200);
		expect(generation).toBe(2);
		expect(killed).toEqual([100]);
		expect(killed[0]).not.toBe(200);
	});

	it("keeps generation 1 when candidate crashes before READY", async () => {
		let activePid = 100;
		let generation = 1;
		const killed: number[] = [];
		let rejected: string | undefined;

		const supervisor = new LiveRuntimeSupervisor({
			watchRoots: [],
			getActivePid: () => activePid,
			getGeneration: () => generation,
			isSessionBusy: () => false,
			waitForSafeBoundary: async () => {},
			validateCandidate: async () => ({ ok: true }),
			killProcess: async pid => {
				killed.push(pid);
			},
			getSessionIdentity: async () => ({
				cwd: "/tmp",
				session_id: "s1",
			}),
			spawnCandidate: async () => ({
				pid: 200,
				ready: Promise.reject(new Error("candidate crashed before READY")),
			}),
			onRejected: reason => {
				rejected = reason;
			},
		});

		await supervisor.notifyCoreChange(["/repo/packages/tui/src/index.ts"]);
		expect(generation).toBe(1);
		expect(activePid).toBe(100);
		expect(killed).toEqual([200]); // candidate terminated; old kept
		expect(rejected).toContain("crashed");
	});

	it("defers activation while busy until safe boundary", async () => {
		let busy = true;
		let boundaryWaited = false;
		let generation = 1;
		const supervisor = new LiveRuntimeSupervisor({
			watchRoots: [],
			getActivePid: () => 1,
			getGeneration: () => generation,
			isSessionBusy: () => busy,
			waitForSafeBoundary: async () => {
				boundaryWaited = true;
				busy = false;
			},
			validateCandidate: async () => ({ ok: true }),
			killProcess: async () => {},
			getSessionIdentity: async () => ({ cwd: "/tmp", session_id: "s" }),
			spawnCandidate: async handoff => ({
				pid: 2,
				ready: Promise.resolve({
					pid: 2,
					generation: handoff.to_generation,
					session_id: "s",
				}),
			}),
			onActivated: signal => {
				generation = signal.generation;
			},
		});

		await supervisor.notifyCoreChange(["/repo/packages/ai/src/x.ts"]);
		expect(boundaryWaited).toBe(true);
		expect(generation).toBe(2);
	});

	it("rejects invalid candidates without killing active pid", async () => {
		const killed: number[] = [];
		let rejected = false;
		const supervisor = new LiveRuntimeSupervisor({
			watchRoots: [],
			getActivePid: () => 42,
			getGeneration: () => 1,
			isSessionBusy: () => false,
			waitForSafeBoundary: async () => {},
			validateCandidate: async () => ({ ok: false, failure_reason: "typecheck failed" }),
			killProcess: async pid => {
				killed.push(pid);
			},
			getSessionIdentity: async () => ({ cwd: "/tmp", session_id: "s" }),
			spawnCandidate: async () => {
				throw new Error("should not spawn");
			},
			onRejected: () => {
				rejected = true;
			},
		});
		await supervisor.notifyCoreChange(["/repo/packages/coding-agent/src/x.ts"]);
		expect(rejected).toBe(true);
		expect(killed).toEqual([]);
	});

	it("classifies extension-only vs core changes", () => {
		expect(classifyChangeTier(["/home/kvn/.omp/agent/extensions/foo.ts"])).toBe("A");
		expect(classifyChangeTier(["/repo/packages/coding-agent/src/main.ts"])).toBe("C");
	});
});
