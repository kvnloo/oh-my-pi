import { afterEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "../../src/async";
import { Settings } from "../../src/config/settings";
import { EVAL_AGENT_BRIDGE_NAME } from "../../src/eval/agent-bridge";
import { runEvalAgent } from "../../src/eval/agent-bridge";
import { runEvalStatus, runEvalWait } from "../../src/eval/handle-bridge";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { EVAL_WORKPOOL_BRIDGE_NAME } from "../../src/eval/workpool-bridge";
import { runEvalWorkpool } from "../../src/eval/workpool-bridge";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as taskDiscovery from "../../src/task/discovery";
import * as structured from "../../src/task/structured-subagent";
import type { StructuredSubagentResult } from "../../src/task/structured-subagent";
import { WorkPoolRegistry } from "../../src/task/workpool";
import type { AgentDefinition, SingleResult } from "../../src/task/types";
import type { ToolSession } from "../../src/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "Task agent",
	systemPrompt: "Handle task",
	source: "bundled",
};

const managers = new Set<AsyncJobManager>();

function makeSession(retentionMs = 60_000): { session: ToolSession; manager: AsyncJobManager } {
	const manager = new AsyncJobManager({ retentionMs });
	managers.add(manager);
	const session: ToolSession = {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			"task.maxConcurrency": 2,
			"task.maxRecursionDepth": 2,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
		}),
		asyncJobManager: manager,
		getAgentId: () => "BridgeParent",
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
	} as unknown as ToolSession;
	return { session, manager };
}

function singleResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "0-Task",
		agent: "task",
		agentSource: "bundled",
		task: "do work",
		assignment: "do work",
		exitCode: 0,
		output: "agent-output",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

function executionResult(overrides: Partial<SingleResult> = {}): StructuredSubagentResult {
	return {
		result: singleResult(overrides),
		mergeSummary: "",
		changesApplied: null,
		artifactsDir: "/tmp/agent-artifacts",
		temporaryArtifacts: false,
		policy: {},
	} as unknown as StructuredSubagentResult;
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("until() timed out waiting for a condition");
		await tick();
	}
}

afterEach(async () => {
	for (const manager of managers) await manager.dispose();
	managers.clear();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	WorkPoolRegistry.resetForTests();
});

describe("runEvalAgent id-collision guard", () => {
	it("throws and cancels the suffixed agent job when the label collides with a running job", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(structured, "runStructuredSubagent").mockResolvedValue(executionResult());

		const { session, manager } = makeSession();

		// Simulate a live workpool pool-job: a `queued: true` "task" job registered
		// directly under its user-chosen name (workpool.ts:#ensurePoolJob).
		const poolFinalized = Promise.withResolvers<void>();
		manager.register(
			"task",
			"review",
			async () => {
				await poolFinalized.promise;
				return "pool-aggregate-result";
			},
			{ id: "review", ownerId: "BridgeParent", queued: true },
		);

		// The agent call must surface the collision as an error instead of silently
		// returning a handle that points at the pool job.
		await expect(runEvalAgent({ prompt: "do work", label: "review" }, { session })).rejects.toThrow(
			'agent label "review" is unavailable (already in use)',
		);

		// The orphaned agent job (silently registered as "review-2" by #resolveJobId)
		// was cancelled — not left running under an id the caller never received.
		const orphan = manager.getJob("review-2");
		expect(orphan?.status).toBe("cancelled");
		expect(orphan?.ownerId).toBe("BridgeParent");
		await orphan?.promise;

		// No completion delivery was enqueued for the cancelled agent.
		await tick();
		expect(manager.hasPendingDeliveries()).toBe(false);

		// The pool job is untouched and remains the owner of the id "review".
		const pool = manager.getJob("review");
		expect(pool?.queued).toBe(true);
		expect(pool?.ownerId).toBe("BridgeParent");

		// status() against "review" reports the pool job's running state, never the
		// agent's (the agent was cancelled, not surfaced under this id).
		const status = runEvalStatus({ item: { kind: "agent", id: "review" } }, { session });
		expect(status.status).toBe("running");

		// The cancelled agent is also addressable as "review-2" (cancelled), proving
		// the agent was registered then cancelled rather than never spawned.
		const orphanStatus = runEvalStatus({ item: { kind: "agent", id: "review-2" } }, { session });
		expect(orphanStatus.status).toBe("cancelled");

		poolFinalized.resolve();
		await manager.getJob("review")!.promise;
	});

	it("throws on a collision with a settled (retained) job and never consumes its result", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(structured, "runStructuredSubagent").mockResolvedValue(executionResult());

		const { session, manager } = makeSession();

		// Register and fully settle a pool-job named "review" BEFORE the agent call,
		// mimicking a drained workpool whose aggregate result is still retained.
		const poolId = manager.register("task", "review", async () => "pool-aggregate-result", {
			id: "review",
			ownerId: "BridgeParent",
		});
		expect(poolId).toBe("review");
		await manager.getJob("review")!.promise;
		expect(manager.getJob("review")?.status).toBe("completed");
		expect(manager.getJob("review")?.resultText).toBe("pool-aggregate-result");
		await tick();

		// The agent call collides with the retained settled job and throws.
		await expect(runEvalAgent({ prompt: "do work", label: "review" }, { session })).rejects.toThrow(/unavailable/i);

		// The cancelled agent job lingers as cancelled.
		await manager.getJob("review-2")?.promise;
		expect(manager.getJob("review-2")?.status).toBe("cancelled");

		// The pool's settled result is NOT consumed by the failed agent call: the
		// caller never received a handle, so it never issued a wait() that would
		// consumeJobResults("review"). The pool result stays reclaimable.
		expect(manager.isJobResultConsumed("review")).toBe(false);
	});

	it("real-path: runEvalWorkpool push then runEvalAgent with the same label throws", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const gate = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
			await gate.promise;
			return executionResult();
		});

		const { session, manager } = makeSession();

		// Real workpool path: create a pool with a user-supplied clean name "review".
		await runEvalWorkpool({ op: "create", name: "review", agent: "task" }, { session });

		// Push an item to trigger #ensurePoolJob, which registers the pool-job at
		// "review" in #jobs. The pool worker's runStructuredSubagent hangs on the
		// gate, so the pool-job stays running.
		await runEvalWorkpool({ op: "push", name: "review", items: ["task1"] }, { session });
		await until(() => manager.getJob("review") !== undefined);
		expect(manager.getJob("review")?.queued).toBe(true);

		// Now call agent({ label: "review" }) — collides with the live pool job and
		// throws instead of silently returning a handle pointing at the pool.
		await expect(runEvalAgent({ prompt: "do work", label: "review" }, { session })).rejects.toThrow(
			'agent label "review" is unavailable (already in use)',
		);

		// The pool job is untouched and still the owner of "review".
		expect(manager.getJob("review")?.queued).toBe(true);

		// The agent was registered as "review-2" then cancelled, not orphaned
		// running.
		expect(manager.getJob("review-2")?.status).toBe("cancelled");
		expect(manager.getJob("review-2")?.ownerId).toBe("BridgeParent");

		// status() against "review" still resolves to the pool job (running), not
		// the cancelled agent.
		const status = runEvalStatus({ item: { kind: "agent", id: "review" } }, { session });
		expect(status.status).toBe("running");

		gate.resolve();
		await manager.getJob("review-2")!.promise.catch(() => {});
		await manager.getJob("review")!.promise.catch(() => {});
	});

	it("returns a handle that resolves to the spawned agent when there is no collision", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(structured, "runStructuredSubagent").mockResolvedValue(executionResult({ output: "agent-output" }));

		const { session, manager } = makeSession();

		const handle = await runEvalAgent({ prompt: "do work", label: "summarize" }, { session });
		expect(handle).toEqual({ id: "summarize", agent: "task" });

		// The registered job id matches the returned handle id verbatim — no
		// silent suffixing, no "summarize-2".
		expect(manager.getJob("summarize")?.id).toBe("summarize");
		expect(manager.getJob("summarize")?.ownerId).toBe("BridgeParent");
		expect(manager.getJob("summarize-2")).toBeUndefined();

		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		const snapshot = waited.items[0];
		expect(snapshot.status).toBe("completed");
		expect(snapshot.text).toBe("agent-output");
		expect(snapshot.id).toBe("summarize");
	});

	it("remains usable for a different label after a collision", async () => {
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		vi.spyOn(structured, "runStructuredSubagent").mockResolvedValue(executionResult({ output: "agent-output" }));

		const { session, manager } = makeSession();

		const poolFinalized = Promise.withResolvers<void>();
		manager.register(
			"task",
			"review",
			async () => {
				await poolFinalized.promise;
				return "pool-aggregate-result";
			},
			{ id: "review", ownerId: "BridgeParent", queued: true },
		);

		// First call collides and throws.
		await expect(runEvalAgent({ prompt: "do work", label: "review" }, { session })).rejects.toThrow(/unavailable/i);
		await manager.getJob("review-2")?.promise;

		// A subsequent agent with a distinct label registers cleanly and returns a
		// handle that resolves to its own job — the manager is not corrupted.
		const handle = await runEvalAgent({ prompt: "do work", label: "summarize" }, { session });
		expect(handle.id).toBe("summarize");
		expect(manager.getJob("summarize")?.id).toBe("summarize");
		expect(manager.getJob("summarize")?.ownerId).toBe("BridgeParent");

		const waited = await runEvalWait({ items: [{ kind: "agent", id: handle.id }] }, { session });
		expect(waited.items[0]).toMatchObject({ status: "completed", text: "agent-output", id: "summarize" });

		poolFinalized.resolve();
		await manager.getJob("review")!.promise;
	});

	it("kernel bridge: callSessionTool __workpool__ then __agent__ with the same label throws", async () => {
		// Exercise the actual JS-eval-kernel tool-bridge entry point
		// (callSessionTool) that eval cells invoke — the layer between a JS eval
		// cell and runEvalAgent/runEvalWorkpool. The bug report verified this
		// dispatch is a thin pass-through (tool-bridge.ts:183-200) with no label
		// normalization or #jobs cross-check, so the host-bridge behavior is
		// representative of the real eval runtime.
		vi.spyOn(taskDiscovery, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
		const gate = Promise.withResolvers<void>();
		vi.spyOn(structured, "runStructuredSubagent").mockImplementation(async () => {
			await gate.promise;
			return executionResult();
		});

		const { session, manager } = makeSession();

		// Drive the kernel bridge for workpool create + push (the path a JS eval
		// cell would take).
		await callSessionTool(EVAL_WORKPOOL_BRIDGE_NAME, { op: "create", name: "review", agent: "task" }, { session });
		await callSessionTool(EVAL_WORKPOOL_BRIDGE_NAME, { op: "push", name: "review", items: ["task1"] }, { session });
		await until(() => manager.getJob("review") !== undefined);
		expect(manager.getJob("review")?.queued).toBe(true);

		// Drive the kernel bridge for agent() with the colliding label — must
		// throw through the same error path as runEvalAgent.
		await expect(
			callSessionTool(EVAL_AGENT_BRIDGE_NAME, { prompt: "do work", label: "review" }, { session }),
		).rejects.toThrow('agent label "review" is unavailable (already in use)');

		// Pool job intact; the suffixed agent was cancelled.
		expect(manager.getJob("review")?.queued).toBe(true);
		expect(manager.getJob("review-2")?.status).toBe("cancelled");

		// A distinct-label agent() through the kernel bridge still resolves to
		// its own job — the bridge layer is not corrupted.
		const handle = await callSessionTool(
			EVAL_AGENT_BRIDGE_NAME,
			{ prompt: "do work", label: "synthesis" },
			{ session },
		);
		expect(handle).toEqual({ id: "synthesis", agent: "task" });
		expect(manager.getJob("synthesis")?.id).toBe("synthesis");

		gate.resolve();
		await manager.getJob("review-2")!.promise.catch(() => {});
		await manager.getJob("review")!.promise.catch(() => {});
		await manager.getJob("synthesis")!.promise.catch(() => {});
	});
});
