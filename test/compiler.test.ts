import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import {
	answerReconstruction,
	compileCognitiveState,
	RECONSTRUCTION_QUESTIONS,
	type FixtureMessage,
} from "../src/compiler.ts";
import { COGNITIVE_STATE_SCHEMA } from "../src/schema.ts";

const fixturesDir = join(import.meta.dir, "../fixtures");

describe("shadow compiler", () => {
	test("every fixture compiles packet + keeps native == input", () => {
		const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && !f.startsWith("paired"));
		expect(files.length).toBeGreaterThanOrEqual(6);
		for (const file of files) {
			const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
			const store = new LocalSpillStore();
			const result = compileCognitiveState({
				messages: fx.messages as FixtureMessage[],
				store,
				objective: fx.objective,
				acceptance: fx.acceptance,
				invariants: fx.invariants,
				phase: fx.phase,
				bottleneck: fx.bottleneck,
				repo_worktree: fx.repo_worktree,
				plan_generation: fx.plan_generation,
				next_action: fx.next_action,
				session_id: fx.id,
			});
			expect(result.packet.schema).toBe(COGNITIVE_STATE_SCHEMA);
			expect(result.packet.diagnostics.provider_receives).toBe("native");
			expect(result.packet.diagnostics.shadow_only).toBe(true);
			expect(result.native_context.map((m) => m.content)).toEqual(
				(fx.messages as FixtureMessage[]).map((m) => m.content),
			);
			expect(result.economics.measured_tokens_avoided).toBe(0);
			expect(result.packet.dialogue.latest_user_input.length).toBeGreaterThan(0);
			expect(result.packet.intent.invariants.length).toBeGreaterThan(0);
		}
	});

	test("safe completed tool raw disappears from VIRTUAL context", () => {
		const store = new LocalSpillStore();
		const raw = "58/58 tests pass\n" + "OUT".repeat(2000);
		const result = compileCognitiveState({
			messages: [
				{ role: "user", content: "Run tests. Do not claim token savings yet." },
				{ role: "tool", tool_name: "bash", tool_call_id: "c1", content: raw },
			],
			store,
			invariants: ["Do not claim token savings yet"],
		});
		const virtTool = result.virtual_context.find((m) => m.role === "tool");
		expect(virtTool).toBeTruthy();
		expect(virtTool!.content.length).toBeLessThan(raw.length / 5);
		expect(virtTool!.content.includes("rlm://h/")).toBe(true);
		expect(virtTool!.content.startsWith("{")).toBe(true);
		expect(result.native_context.find((m) => m.role === "tool")!.content).toBe(raw);
	});

	test("unresolved error stays visible in virtual LIVE path", () => {
		const store = new LocalSpillStore();
		const raw = "Error: bun hang\n" + "wait ".repeat(500);
		const result = compileCognitiveState({
			messages: [
				{ role: "user", content: "Fix hang. Do not summarize unresolved tool state away." },
				{ role: "tool", tool_name: "bash", tool_call_id: "h1", is_error: true, content: raw },
			],
			store,
			invariants: ["Do not summarize unresolved tool state away"],
		});
		const virtTool = result.virtual_context.find((m) => m.role === "tool");
		expect(virtTool!.content).toBe(raw);
		expect(result.packet.work.some((w) => w.status === "active")).toBe(true);
	});

	test("reconstruction answers for all fixtures", () => {
		const files = readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && !f.startsWith("paired"));
		for (const file of files) {
			const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
			const store = new LocalSpillStore();
			const { packet } = compileCognitiveState({
				messages: fx.messages,
				store,
				objective: fx.objective,
				acceptance: fx.acceptance,
				invariants: fx.invariants,
				phase: fx.phase,
				bottleneck: fx.bottleneck,
				next_action: fx.next_action,
			});
			const answers = answerReconstruction(packet);
			for (const q of RECONSTRUCTION_QUESTIONS) {
				expect(answers[q].length).toBeGreaterThan(0);
				expect(answers[q]).not.toBe("(unspecified objective)");
			}
			expect(answers["what are we trying to do?"]).toContain(fx.objective.slice(0, 40));
		}
	});

	test("evidence retrievable via store handles", () => {
		const store = new LocalSpillStore();
		const raw = "gold_ok=16\n" + "pair ".repeat(100);
		const { packet, receipts } = compileCognitiveState({
			messages: [
				{ role: "user", content: "WorkerNeededReplay. Do not delete current RLM paths." },
				{ role: "tool", tool_name: "bash", tool_call_id: "w1", content: raw },
			],
			store,
			invariants: ["Do not delete current RLM paths"],
		});
		expect(receipts[0]).toBeTruthy();
		const got = store.get(receipts[0]!.artifact_handle);
		expect(got?.text).toBe(raw);
		expect(packet.evidence[0]?.handle).toBe(receipts[0]!.artifact_handle);
		expect(store.search(receipts[0]!.artifact_handle, "gold_ok").length).toBeGreaterThan(0);
	});
});
