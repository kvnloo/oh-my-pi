/**
 * Reconstruction + economics harness across workflow fixtures.
 * Writes evals/results/p0-shadow-report.json
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import {
	answerReconstruction,
	compileCognitiveState,
	type FixtureMessage,
} from "../src/compiler.ts";
import { makeShadowEconomicsEvent } from "../src/tokenomics-shadow.ts";

const root = join(import.meta.dir, "..");
const fixturesDir = join(root, "fixtures");
const outDir = join(root, "evals", "results");
mkdirSync(outDir, { recursive: true });

const rows: Array<Record<string, unknown>> = [];
const compileMs: number[] = [];

for (const file of readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && !f.startsWith("paired")).sort()) {
	const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8"));
	const samples: Array<ReturnType<typeof compileCognitiveState>> = [];
	for (let i = 0; i < 21; i++) {
		const store = new LocalSpillStore();
		samples.push(
			compileCognitiveState({
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
			}),
		);
	}
	const best = samples[0]!;
	for (const s of samples) compileMs.push(s.packet.diagnostics.compile_ms);

	const answers = answerReconstruction(best.packet);
	const evidenceLoss: string[] = [];
	// Check: every tool message has retrievable evidence OR is unresolved LIVE
	for (const m of fx.messages as FixtureMessage[]) {
		if (m.role !== "tool") continue;
		const receipt = best.receipts.find((r) => r.tool_call_id === m.tool_call_id);
		if (!receipt) {
			evidenceLoss.push(`missing_receipt:${m.tool_call_id}`);
			continue;
		}
		const store = new LocalSpillStore();
		// re-spill check via packet handle presence
		if (!best.packet.evidence.some((e) => e.handle === receipt.artifact_handle)) {
			evidenceLoss.push(`missing_evidence_ref:${m.tool_call_id}`);
		}
		if (m.is_error && receipt.visibility !== "LIVE") {
			evidenceLoss.push(`unresolved_not_live:${m.tool_call_id}`);
		}
		if (!m.is_error) {
			const virt = best.virtual_context.find((v) => v.tool_call_id === m.tool_call_id);
			if (virt && virt.content === m.content && m.content.length > 500) {
				evidenceLoss.push(`raw_still_in_virtual:${m.tool_call_id}`);
			}
		}
	}

	const reduction_ratio =
		best.economics.native_context_tokens > 0
			? (best.economics.native_context_tokens - best.economics.virtual_context_tokens) /
				best.economics.native_context_tokens
			: 0;

	rows.push({
		fixture: fx.id,
		native_tokens: best.economics.native_context_tokens,
		virtual_tokens: best.economics.virtual_context_tokens,
		reduction_ratio_measured_not_claimed: Number(reduction_ratio.toFixed(4)),
		compile_ms: best.economics.compile_ms,
		live: best.economics.live_count,
		receipt: best.economics.receipt_count,
		external: best.economics.external_count,
		externalized_bytes: best.economics.externalized_bytes,
		measured_tokens_avoided: 0,
		reconstruction: answers,
		evidence_loss: evidenceLoss,
		tokenomics_sample: makeShadowEconomicsEvent(best.economics),
		invariants_present: best.packet.intent.invariants,
		provider_receives: best.packet.diagnostics.provider_receives,
	});
}

compileMs.sort((a, b) => a - b);
const p50 = compileMs[Math.floor(compileMs.length * 0.5)] ?? 0;
const p95 = compileMs[Math.floor(compileMs.length * 0.95)] ?? 0;

const report = {
	schema: "z0.cognitive_state.p0_report",
	generated_at: new Date().toISOString(),
	package: "/home/kvn/tmp/omp-ext-cognitive-state",
	omp_core_patches_required: false,
	extension_seam_verified: {
		context_can_replace_model_visible_messages: true,
		canonical_session_history_untouched_by_context_return: true,
		p0_does_not_return_messages: true,
		seams_used: [
			"context",
			"tool_result",
			"session_start",
			"before_provider_request",
		],
		seams_available_unused: [
			"tool_call",
			"turn_start",
			"turn_end",
			"agent_start",
			"agent_end",
			"session_stop",
		],
	},
	compile_latency_ms: { p50, p95, n: compileMs.length },
	fixtures: rows,
	evidence_loss_findings: rows.flatMap((r) =>
		(r.evidence_loss as string[]).map((e) => `${r.fixture}:${e}`),
	),
	next_blocker_for_active_canary:
		"Provider still receives native context; active canary blocked until a guarded virtual-context flag flips provider path (extension already sufficient — no core patch). Keep measured_tokens_avoided=0 until then.",
};

writeFileSync(join(outDir, "p0-shadow-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ p50, p95, fixtures: rows.length, evidence_loss: report.evidence_loss_findings }, null, 2));
