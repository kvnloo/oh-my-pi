/**
 * P1 guarded canary: 20 paired frozen A/B tasks + 10 live opt-in canary turns.
 * Writes evals/results/p1-canary-report.json
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import { compileCognitiveState, answerReconstruction, type FixtureMessage } from "../src/compiler.ts";
import { createCanaryHost, decideCanaryContext, resolveFallback } from "../src/canary-runtime.ts";
import { estimateTokens } from "../src/tokens.ts";
import type { FallbackReason } from "../src/fallback.ts";
import type { TaskClass } from "../src/task-gate.ts";

const root = join(import.meta.dir, "..");
const pairedDir = join(root, "fixtures", "paired");
const outDir = join(root, "evals", "results");
mkdirSync(outDir, { recursive: true });

type PairRow = {
	task_id: string;
	task_class: string;
	verified_A: boolean;
	verified_B: boolean;
	root_input_tokens_A: number;
	root_input_tokens_B: number;
	total_tokens_A: number;
	total_tokens_B: number;
	latency_ms_A: number;
	latency_ms_B: number;
	tool_calls_A: number;
	tool_calls_B: number;
	retries_A: number;
	retries_B: number;
	retrievals_A: number;
	retrievals_B: number;
	fallback: boolean;
	fallback_reason?: FallbackReason;
	evidence_miss: boolean;
	context_compile_ms: number;
	measured_tokens_avoided: number;
};

function verifyPacket(
	task: { objective: string; invariants: string[]; verifier: Record<string, unknown> },
	compile: ReturnType<typeof compileCognitiveState>,
	store: LocalSpillStore,
): { ok: boolean; evidence_miss: boolean } {
	const answers = answerReconstruction(compile.packet);
	const objOk = answers["what are we trying to do?"].includes(String(task.verifier.require_objective_substring ?? "").slice(0, 12))
		|| compile.packet.intent.objective.includes(task.objective.slice(0, 20));
	const invOk = !task.verifier.require_invariants || compile.packet.intent.invariants.length > 0;
	let evidence_miss = false;
	for (const ev of compile.packet.evidence) {
		if (!store.get(ev.handle)) evidence_miss = true;
	}
	const evidenceOk = !task.verifier.require_evidence_handles_resolvable || !evidence_miss;
	return { ok: Boolean(objOk && invOk && evidenceOk), evidence_miss };
}

function mockProvider(context: FixtureMessage[], arm: "A" | "B", task: { objective: string }): {
	assistant_text: string;
	tool_calls: number;
	latency_ms: number;
} {
	const t0 = performance.now();
	const blob = context.map((m) => m.content).join("\n");
	const hasReceipt = /z0\.tool_receipt\.v1|rlm:\/\/h\//.test(blob);
	const asksMissing = arm === "B" && /FORCE_MISSING_CONTEXT/.test(task.objective);
	const assistant_text = asksMissing
		? "Please paste the earlier full raw output; missing context."
		: `Proceeding on ${task.objective.slice(0, 80)}. ${hasReceipt ? "Using receipts." : "Using native tool bodies."} verified=true`;
	const tool_calls = /debug|hang|failing/i.test(task.objective) ? 2 : 1;
	return { assistant_text, tool_calls, latency_ms: Math.round((performance.now() - t0) * 1000) / 1000 };
}

const pairRows: PairRow[] = [];
const compileSamples: number[] = [];

for (const file of readdirSync(pairedDir).filter((f) => f.endsWith(".json")).sort()) {
	const task = JSON.parse(readFileSync(join(pairedDir, file), "utf8"));
	const messages = task.messages as FixtureMessage[];

	// Arm A — native
	const storeA = new LocalSpillStore();
	const tA0 = performance.now();
	const compileA = compileCognitiveState({
		messages,
		store: storeA,
		objective: task.objective,
		invariants: task.invariants,
		provider_receives: "native",
		context_mode: "native",
	});
	const latencyCompileA = performance.now() - tA0;
	compileSamples.push(compileA.packet.diagnostics.compile_ms);
	const provA = mockProvider(compileA.native_context, "A", task);
	const verA = verifyPacket(task, compileA, storeA);

	// Arm B — canary virtual (+ fallback if needed)
	const storeB = new LocalSpillStore();
	const host = createCanaryHost({
		store: storeB,
		mode: "canary",
		canary_opt_in: true,
	});
	const decision = decideCanaryContext(host, messages, {
		objective: task.objective,
		invariants: task.invariants,
		explicit_task_class: task.task_class as TaskClass,
	});
	compileSamples.push(decision.compile.packet.diagnostics.compile_ms);

	let contextB = decision.compile.virtual_context;
	let fallback = false;
	let fallback_reason: FallbackReason | undefined;
	let retries_B = 0;
	let measured = 0;

	const provB1 = mockProvider(contextB, "B", task);
	const verB1 = verifyPacket(task, decision.compile, storeB);
	const askMissing = /missing context|full raw output/i.test(provB1.assistant_text);

	const outcome = resolveFallback(host, decision, {
		assistant_text: provB1.assistant_text,
		verified: verB1.ok && !askMissing,
		verifier_failed: !verB1.ok || askMissing,
		native_verifier_passed: verA.ok,
		tool_calls: provB1.tool_calls,
		repeated_known_state_requests: askMissing ? 2 : 0,
	});

	if (outcome.fallback) {
		fallback = true;
		fallback_reason = outcome.reason;
		retries_B = 1;
		contextB = decision.native_preserve;
		const provB2 = mockProvider(contextB, "A", task);
		void provB2;
		measured = 0;
	} else if (verB1.ok && decision.canary_active) {
		measured = Math.max(0, compileA.economics.native_context_tokens - decision.compile.economics.virtual_context_tokens);
	}

	const verB = fallback ? verA : verB1;

	pairRows.push({
		task_id: task.id,
		task_class: task.task_class,
		verified_A: verA.ok,
		verified_B: verB.ok,
		root_input_tokens_A: compileA.economics.native_context_tokens,
		root_input_tokens_B: fallback
			? compileA.economics.native_context_tokens
			: decision.compile.economics.virtual_context_tokens,
		total_tokens_A: compileA.economics.native_context_tokens + estimateTokens(provA.assistant_text),
		total_tokens_B:
			(fallback ? compileA.economics.native_context_tokens : decision.compile.economics.virtual_context_tokens) +
			estimateTokens(provB1.assistant_text) +
			(fallback ? compileA.economics.native_context_tokens : 0),
		latency_ms_A: Number((latencyCompileA + provA.latency_ms).toFixed(3)),
		latency_ms_B: Number((decision.compile.economics.compile_ms + provB1.latency_ms).toFixed(3)),
		tool_calls_A: provA.tool_calls,
		tool_calls_B: provB1.tool_calls + (fallback ? 1 : 0),
		retries_A: 0,
		retries_B,
		retrievals_A: 0,
		retrievals_B: decision.compile.packet.evidence.length,
		fallback,
		fallback_reason,
		evidence_miss: verB1.evidence_miss || verA.evidence_miss,
		context_compile_ms: decision.compile.economics.compile_ms,
		measured_tokens_avoided: measured,
	});
}

// 10 live opt-in canary turns through extension seam (deterministic mock provider)
const liveTurns: Array<Record<string, unknown>> = [];
for (let i = 0; i < 10; i++) {
	const baseFile = readdirSync(pairedDir).filter((f) => f.endsWith(".json")).sort()[i]!;
	const task = JSON.parse(readFileSync(join(pairedDir, baseFile), "utf8"));
	const store = new LocalSpillStore();
	const host = createCanaryHost({ store, mode: "canary", canary_opt_in: true });
	const decision = decideCanaryContext(host, task.messages, {
		objective: task.objective,
		invariants: task.invariants,
		explicit_task_class: task.task_class,
		user_turn_id: `live-${i + 1}`,
	});
	const returnedVirtual = Boolean(decision.messages?.length);
	const prov = mockProvider(decision.compile.virtual_context, "B", task);
	const ver = verifyPacket(task, decision.compile, store);
	const fb = resolveFallback(host, decision, {
		assistant_text: prov.assistant_text,
		verified: ver.ok,
		verifier_failed: !ver.ok,
		native_verifier_passed: true,
		tool_calls: prov.tool_calls,
	});
	liveTurns.push({
		live_turn: i + 1,
		task_id: task.id,
		canary_active: decision.canary_active,
		returned_virtual_messages: returnedVirtual,
		context_mode: fb.record.context_mode,
		verified: fb.record.virtual_verified || Boolean(fb.fallback && ver.ok),
		fallback: fb.fallback,
		fallback_reason: fb.reason,
		native_tokens: decision.compile.economics.native_context_tokens,
		virtual_tokens: decision.compile.economics.virtual_context_tokens,
		compile_ms: decision.compile.economics.compile_ms,
		ids: fb.ids,
	});
}

compileSamples.sort((a, b) => a - b);
const p50 = compileSamples[Math.floor(compileSamples.length * 0.5)] ?? 0;
const p95 = compileSamples[Math.floor(compileSamples.length * 0.95)] ?? 0;

const verifiedA = pairRows.filter((r) => r.verified_A).length;
const verifiedB = pairRows.filter((r) => r.verified_B).length;
const fallbacks = pairRows.filter((r) => r.fallback);
const evidenceLoss = pairRows.filter((r) => r.evidence_miss);
const nativeTok = pairRows.reduce((a, r) => a + r.root_input_tokens_A, 0);
const virtualTok = pairRows.reduce((a, r) => a + r.root_input_tokens_B, 0);
const measuredSaved = pairRows.reduce((a, r) => a + r.measured_tokens_avoided, 0);
const fallbackReasons: Record<string, number> = {};
for (const r of [...pairRows, ...liveTurns.map((t) => ({ fallback: t.fallback, fallback_reason: t.fallback_reason }))]) {
	if (r.fallback && r.fallback_reason) {
		const k = String(r.fallback_reason);
		fallbackReasons[k] = (fallbackReasons[k] ?? 0) + 1;
	}
}

const qualityNonInferior = verifiedB >= verifiedA - 0; // require non-inferior exact for frozen set
const materialReduction = measuredSaved > 0 && virtualTok < nativeTok;
const fallbackOk = fallbacks.length > 0 && fallbacks.every((f) => f.fallback_reason);
const compileNegligible = p95 < 50; // ms vs provider latency

let recommendation: "stay_canary" | "expand_canary" | "active_with_fallback" = "stay_canary";
if (qualityNonInferior && evidenceLoss.length === 0 && fallbackOk && materialReduction && compileNegligible) {
	recommendation = fallbacks.length === 0 ? "expand_canary" : "active_with_fallback";
}
if (!qualityNonInferior || evidenceLoss.length > 0) recommendation = "stay_canary";

const pkgSha = createHash("sha256")
	.update(readFileSync(join(root, "src/canary-runtime.ts")))
	.update(readFileSync(join(root, "src/extension.ts")))
	.update(readFileSync(join(root, "src/mode.ts")))
	.digest("hex")
	.slice(0, 16);

const report = {
	schema: "z0.cognitive_state.p1_canary_report",
	generated_at: new Date().toISOString(),
	package: "/home/kvn/tmp/omp-ext-cognitive-state",
	package_content_sha16: pkgSha,
	omp_core_patches_required: false,
	mode_config_surface: {
		modes: ["off", "shadow", "canary"],
		default: "shadow",
		canary_requires: ["mode=canary", "canary_opt_in=true", "safe task class allowlist"],
		env: ["OMP_COGNITIVE_STATE_MODE", "OMP_COGNITIVE_STATE_CANARY_OPT_IN"],
		settings: ["cognitiveState.mode", "cognitiveState.canaryOptIn"],
	},
	paired_ab: pairRows,
	paired_summary: {
		n: pairRows.length,
		verified_success_A: verifiedA,
		verified_success_B: verifiedB,
		verified_success_delta: verifiedB - verifiedA,
		native_root_tokens_sum: nativeTok,
		virtual_or_fallback_root_tokens_sum: virtualTok,
		native_vs_virtual_token_delta: nativeTok - virtualTok,
		measured_tokens_avoided_sum: measuredSaved,
		fallback_count: fallbacks.length,
		fallback_reasons: fallbackReasons,
		evidence_loss_incidents: evidenceLoss.map((e) => e.task_id),
	},
	live_canary: {
		n: liveTurns.length,
		turns: liveTurns,
		returned_virtual: liveTurns.filter((t) => t.returned_virtual_messages).length,
		fallbacks: liveTurns.filter((t) => t.fallback).length,
	},
	compile_latency_ms: { p50, p95, n: compileSamples.length },
	promotion_gate: {
		verified_quality_non_inferior: qualityNonInferior,
		no_dangerous_evidence_loss: evidenceLoss.length === 0,
		fallback_behavior_works: fallbackOk,
		root_token_reduction_material: materialReduction,
		compile_overhead_negligible: compileNegligible,
	},
	recommendation,
	note: "Live turns exercise the same canary decide/fallback path with a deterministic mock provider (opt-in canary, no default flip). Paired A/B uses frozen task snapshots.",
};

writeFileSync(join(outDir, "p1-canary-report.json"), JSON.stringify(report, null, 2));
console.log(
	JSON.stringify(
		{
			paired: pairRows.length,
			live: liveTurns.length,
			verified_delta: verifiedB - verifiedA,
			fallback_count: fallbacks.length,
			evidence_loss: evidenceLoss.length,
			p50,
			p95,
			recommendation,
			pkgSha,
		},
		null,
		2,
	),
);
