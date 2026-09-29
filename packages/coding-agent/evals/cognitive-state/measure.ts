import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	PUBLIC_EVIDENCE,
	RLM_DONOR_REF,
	RLM_DONOR_SPILL_BYTES,
	contextBytes,
	handleCognitiveStateContext,
	measureArms,
	resolveFromAgentsView,
	resolveFromZ0int,
} from "../../examples/extensions/cognitive-state/index.ts";
import type { ContextMessage, HarnessReceipt } from "../../examples/extensions/cognitive-state/index.ts";
import { FROZEN_QUESTIONS } from "../../examples/extensions/cognitive-state/frozen.ts";

const outPath = new URL("./measurements.json", import.meta.url);

function toolResult(text: string): ContextMessage {
	return { role: "toolResult", toolName: "read", content: [{ type: "text", text }], timestamp: 2 };
}

function marked(id: string): ContextMessage[] {
	return [toolResult("native-transcript"), { role: "user", content: `z0evals#56:${id}`, timestamp: 1 }];
}

const sourceRevision = process.env.OMP_SOURCE_REVISION ?? "984fa8bcc5d49463d2d5fe5be0e2cb86542ae507";
const rows: HarnessReceipt[] = [];
for (const question of FROZEN_QUESTIONS) {
	const shadow = await handleCognitiveStateContext(
		{ type: "context", messages: marked(question.id) },
		{ mode: "shadow", sessionId: "measure", traceId: `shadow-${question.id}`, sourceRevision },
	);
	const canary = await handleCognitiveStateContext(
		{ type: "context", messages: marked(question.id) },
		{ mode: "canary", sessionId: "measure", traceId: `canary-${question.id}`, sourceRevision },
	);
	if (shadow.receipt) rows.push(shadow.receipt);
	if (canary.receipt) rows.push(canary.receipt);
}

const growth: Array<{ turn: number; arms: HarnessReceipt["arms"]; growth: HarnessReceipt["root_context_growth_per_turn"] }> = [];
let native = marked("minimum-sufficient");
let previous: HarnessReceipt["arms"] | undefined;
for (let turn = 1; turn <= 4; turn++) {
	native = [...native, toolResult(`${"q".repeat(40_000)}MIDDLE-${turn}${"z".repeat(40_000)}`)];
	const result = await handleCognitiveStateContext(
		{ type: "context", messages: native },
		{
			mode: "canary",
			sessionId: "measure",
			traceId: `growth-${turn}`,
			sourceRevision,
			previousArms: previous,
		},
	);
	previous = result.receipt?.arms;
	growth.push({
		turn,
		arms: result.receipt!.arms,
		growth: result.receipt!.root_context_growth_per_turn,
	});
}

const pythonPath = process.env.Z0INT_PYTHONPATH;
const z0int = pythonPath
	? await resolveFromZ0int("z0int.context_resolve.v1", async (command, args, env) => {
			const proc = Bun.spawn([command, ...args], {
				env: { ...process.env, ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			return { code: await proc.exited, stdout, stderr };
		}, {
			pythonPath,
			projectRoot: process.env.Z0INT_PROJECT_ROOT,
			exactPath: process.env.Z0INT_EXACT_PATH,
		})
	: { evidence: [], raw_source_reads: 0, gaps: ["z0int: Z0INT_PYTHONPATH unset"], retrieval_capability: "z0int.context_resolve.v1" };
const agentsview = await resolveFromAgentsView("z0int.context_resolve.v1", async (command, args) => {
	const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	return { code: await proc.exited, stdout, stderr: stderr.slice(0, 200) };
});

const payload = {
	schema: "omp.cognitive_state.measure.v1",
	harness: "omp",
	donor_spill: { ref: RLM_DONOR_REF, spill_bytes: RLM_DONOR_SPILL_BYTES },
	public_evidence_locators: PUBLIC_EVIDENCE.map(ref => ref.locator),
	questions: rows.map(row => ({
		question_id: row.question_id,
		mode: row.mode,
		sent: row.sent,
		injected: row.injected,
		answer_supported: row.answer_supported,
		abstained: row.abstained,
		verified: row.verified,
		evidence_refs: row.evidence_refs,
		raw_source_reads: row.raw_source_reads,
		context_bytes: row.context_bytes,
		would_send_bytes: row.would_send_bytes,
		evidence_quality: row.evidence_quality,
		arms: row.arms,
		duplicate_injection: row.duplicate_injection,
	})),
	growth,
	turn4_native_bytes: contextBytes(native),
	live: {
		z0int: {
			retrieval_capability: z0int.retrieval_capability,
			revision: process.env.Z0INT_REVISION ?? "unset",
			evidence_refs: z0int.evidence.map(ref => ref.locator.replace(/^\/tmp\/z0intelligence\//, "kvnloo/z0intelligence:")),
			raw_source_reads: z0int.raw_source_reads,
			gaps: z0int.gaps,
		},
		agentsview: {
			retrieval_capability: agentsview.retrieval_capability,
			evidence_refs: agentsview.evidence.map(ref => ref.locator),
			raw_source_reads: agentsview.raw_source_reads,
			gaps: agentsview.gaps,
		},
	},
};

mkdirSync(dirname(outPath.pathname), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(outPath.pathname);
console.log(
	JSON.stringify({
		questions: payload.questions.length,
		growth_turn4: growth[3],
		z0int_gaps: z0int.gaps,
		agentsview_gaps: agentsview.gaps,
	}),
);
