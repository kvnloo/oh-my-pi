import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	PUBLIC_EVIDENCE,
	assertShaRevision,
	RLM_DONOR_REF,
	RLM_DONOR_SPILL_BYTES,
	contextBytes,
	handleCognitiveStateContext,
	resolveFromAgentsView,
	resolveFromZ0int,
	toEvidenceRef,
	validateUnifiedReceipt,
} from "../../examples/extensions/cognitive-state/index.ts";
import type { ArmBytes, ContextMessage, UnifiedMemoryReceipt } from "../../examples/extensions/cognitive-state/index.ts";
import { FROZEN_QUESTIONS } from "../../examples/extensions/cognitive-state/frozen.ts";

const outPath = new URL("./measurements.json", import.meta.url);
const receiptPath = new URL("./receipts.jsonl", import.meta.url);
const schemaPath = new URL("./receipt.schema.json", import.meta.url);
const questionsPath = new URL("./question-contract.json", import.meta.url);

function toolResult(text: string): ContextMessage {
	return { role: "toolResult", toolName: "read", content: [{ type: "text", text }], timestamp: 2 };
}

function marked(id: string): ContextMessage[] {
	return [toolResult("native-transcript"), { role: "user", content: `z0evals#56:${id}`, timestamp: 1 }];
}

// Fail closed rather than reporting another source tree as the measured harness.
const sourceRevision = assertShaRevision(process.env.OMP_SOURCE_REVISION ?? "");
const canonicalIds = (JSON.parse(readFileSync(questionsPath, "utf8")) as { questions: Array<{ id: string }> }).questions.map(question => question.id);
if (JSON.stringify(FROZEN_QUESTIONS.map(question => question.id)) !== JSON.stringify(canonicalIds)) {
	throw new Error("Frozen OMP question IDs drifted from the pinned z0evals contract");
}
const wire: UnifiedMemoryReceipt[] = [];
const shadowBytes: Array<{ question_id: string; context_bytes: number; would_send_bytes: number }> = [];
for (const question of FROZEN_QUESTIONS) {
	const shadow = await handleCognitiveStateContext(
		{ type: "context", messages: marked(question.id) },
		{ mode: "shadow", sessionId: "measure", traceId: `shadow-${question.id}`, sourceRevision },
	);
	const canary = await handleCognitiveStateContext(
		{ type: "context", messages: marked(question.id) },
		{ mode: "canary", sessionId: "measure", traceId: `canary-${question.id}`, sourceRevision },
	);
	if (canary.receipt) wire.push(canary.receipt);
	if (shadow.analysis) {
		shadowBytes.push({
			question_id: question.id,
			context_bytes: shadow.receipt?.context_bytes ?? 0,
			would_send_bytes: shadow.analysis.would_send_bytes,
		});
	}
}

const growth: Array<{ turn: number; arms: ArmBytes; growth: ArmBytes }> = [];
let native = marked("minimal-context");
let previous: ArmBytes | undefined;
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
	previous = result.analysis?.arms;
	growth.push({
		turn,
		arms: result.analysis!.arms,
		growth: result.analysis!.root_context_growth_per_turn,
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

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as { required?: string[]; properties?: Record<string, unknown> };
const schemaErrors = wire.flatMap((row, index) => validateUnifiedReceipt(row, schema).map(error => `${index}: ${error}`));
if (schemaErrors.length > 0) throw new Error(schemaErrors.join("\n"));
const agentsviewLimitation = "agentsview: search unavailable because ~/.agentsview is a symlink; failed closed, no invented hit";
const payload = {
	schema: "omp.cognitive_state.measure.v1",
	contract: "z0eval.unified_memory_receipt.v0",
	contract_revision: "8341084c4967bd25236ef011e6efdbace27d03bd",
	receipts: "receipts.jsonl",
	donor_spill: { ref: RLM_DONOR_REF, spill_bytes: RLM_DONOR_SPILL_BYTES },
	public_evidence_locators: PUBLIC_EVIDENCE.map(ref => ref.locator),
	shadow_bytes: shadowBytes,
	growth,
	turn4_native_bytes: contextBytes(native),
	limitations: agentsview.gaps.length > 0 ? [agentsviewLimitation, ...agentsview.gaps] : [],
	live: {
		z0int: {
			retrieval_capability: z0int.retrieval_capability,
			retrieval_ok: z0int.gaps.length === 0 && z0int.evidence.length > 0,
			revision: process.env.Z0INT_REVISION ?? "unset",
			evidence_refs: z0int.evidence.map(toEvidenceRef),
			raw_source_reads: z0int.raw_source_reads,
			gaps: z0int.gaps,
		},
		agentsview: {
			retrieval_capability: agentsview.retrieval_capability,
			retrieval_ok: false,
			evidence_refs: agentsview.evidence.map(toEvidenceRef),
			raw_source_reads: agentsview.raw_source_reads,
			gaps: agentsview.gaps.length > 0 ? agentsview.gaps : [agentsviewLimitation],
		},
	},
};
mkdirSync(dirname(outPath.pathname), { recursive: true });
writeFileSync(receiptPath, `${wire.map(row => JSON.stringify(row)).join("\n")}\n`);
writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(receiptPath.pathname);
console.log(JSON.stringify({ receipts: wire.length, growth_turn4: growth[3], agentsview_gaps: payload.live.agentsview.gaps }));
