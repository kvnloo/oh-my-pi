import type { EvidenceRef, FrozenQuestion } from "./types.ts";

/**
 * Public fixtures only. No private transcript text.
 * Supersession and contradiction rows are labeled eval fixtures, not OMP history.
 */
export const PUBLIC_EVIDENCE: EvidenceRef[] = [
	{
		source_id: "z0int:context_resolve",
		source_version: "SCHEMA",
		locator: "kvnloo/z0intelligence:src/z0int/context_resolve.py:SCHEMA",
		trust_class: "code",
		observed_at: "2026-09-29T04:37:50Z",
		excerpt: "z0int.context_resolve.v1",
		entity: "context-resolve-schema",
		claim: "z0int.context_resolve.v1",
		plane: "EXTERNAL",
		required_need: "schema",
	},
	{
		source_id: "donor:pr-77:spill-bytes",
		source_version: "20480",
		locator: "kvnloo/oh-my-pi#77:packages/coding-agent/src/rlm/store.ts:RLM_DEFAULT_SPILL_BYTES",
		trust_class: "code",
		observed_at: "2026-09-18T04:13:48Z",
		excerpt: "RLM_DEFAULT_SPILL_BYTES = 20480",
		entity: "donor-spill-bytes",
		claim: "RLM_DEFAULT_SPILL_BYTES = 20480",
		plane: "EXTERNAL",
		required_need: "spill-bytes",
	},
	{
		source_id: "z0evals:56:harness-row",
		source_version: "issue-56",
		locator: "kvnloo/z0evals#56:harness-matrix",
		trust_class: "authoritative_task",
		observed_at: "2026-09-29T00:00:00Z",
		excerpt:
			"harness question_id session_id trace_id source_revision retrieval_capability evidence_refs injected answer_supported abstained raw_source_reads context_bytes",
		entity: "harness-receipt-fields",
		claim:
			"harness question_id evidence_refs injected answer_supported abstained raw_source_reads context_bytes",
		plane: "EXTERNAL",
		required_need: "harness-fields",
	},
	{
		source_id: "eval-fixture:cap:v1",
		source_version: "1",
		locator: "eval-fixture:cap@v1",
		trust_class: "derived_memory",
		observed_at: "2026-01-01T00:00:00Z",
		excerpt: "eval-fixture-cap=8192",
		entity: "eval-fixture-cap",
		claim: "eval-fixture-cap=8192",
		plane: "EXTERNAL",
		required_need: "cap",
	},
	{
		source_id: "eval-fixture:cap:v2",
		source_version: "2",
		locator: "eval-fixture:cap@v2",
		trust_class: "derived_memory",
		observed_at: "2026-09-18T04:13:48Z",
		excerpt: "eval-fixture-cap=20480",
		entity: "eval-fixture-cap",
		claim: "eval-fixture-cap=20480",
		plane: "EXTERNAL",
		required_need: "cap",
	},
	{
		source_id: "eval-fixture:jsonl:retained",
		source_version: "a",
		locator: "eval-fixture:jsonl@retained",
		trust_class: "unknown",
		observed_at: "2026-06-01T00:00:00Z",
		excerpt: "eval-fixture-jsonl: retained",
		entity: "eval-fixture-jsonl",
		claim: "eval-fixture-jsonl: retained",
		plane: "EXTERNAL",
		required_need: "jsonl",
	},
	{
		source_id: "eval-fixture:jsonl:deleted",
		source_version: "b",
		locator: "eval-fixture:jsonl@deleted",
		trust_class: "unknown",
		observed_at: "2026-06-02T00:00:00Z",
		excerpt: "eval-fixture-jsonl: deleted",
		entity: "eval-fixture-jsonl",
		claim: "eval-fixture-jsonl: deleted",
		plane: "EXTERNAL",
		required_need: "jsonl",
	},
	{
		source_id: "eval-fixture:old-uncontradicted",
		source_version: "1",
		locator: "eval-fixture:old@2020",
		trust_class: "code",
		observed_at: "2020-01-01T00:00:00Z",
		excerpt: "eval-fixture-old=still-current",
		entity: "eval-fixture-old",
		claim: "eval-fixture-old=still-current",
		plane: "EXTERNAL",
		required_need: "old",
	},
];

export const FROZEN_QUESTIONS: readonly FrozenQuestion[] = [
	{
		id: "exact-identifier",
		family: "exact-identifier",
		prompt: "What schema id does z0int context resolve publish?",
		needs: [{ id: "schema", description: "context resolve schema id", kind: "exact_symbol", required: true }],
		expected_action: "answer",
		expected_support: ["z0int.context_resolve.v1"],
		forbidden: [],
		evidence_ids: ["z0int:context_resolve"],
	},
	{
		id: "supersession",
		family: "supersession",
		prompt: "Which eval-fixture-cap is current, and which value remains inspectable as superseded?",
		needs: [{ id: "cap", description: "current eval fixture cap", required: true }],
		expected_action: "answer",
		expected_support: ["eval-fixture-cap=20480"],
		forbidden: [],
		evidence_ids: ["eval-fixture:cap:v1", "eval-fixture:cap:v2"],
	},
	{
		id: "cross-harness",
		family: "cross-harness",
		prompt: "Which fields does z0evals#56 require on every harness receipt row?",
		needs: [{ id: "harness-fields", description: "public harness receipt fields", required: true }],
		expected_action: "answer",
		expected_support: ["evidence_refs", "answer_supported", "raw_source_reads", "context_bytes"],
		forbidden: [],
		evidence_ids: ["z0evals:56:harness-row"],
	},
	{
		id: "contradiction",
		family: "contradiction",
		prompt: "Two eval-fixture-jsonl sources disagree. Report both with provenance. Do not pick a winner.",
		needs: [{ id: "jsonl", description: "both jsonl fixture claims", required: true }],
		expected_action: "observe",
		expected_support: ["eval-fixture-jsonl: retained", "eval-fixture-jsonl: deleted"],
		forbidden: ["JSONL-DELETED-WINNER"],
		evidence_ids: ["eval-fixture:jsonl:retained", "eval-fixture:jsonl:deleted"],
	},
	{
		id: "missing-evidence",
		family: "missing-evidence",
		prompt: "What did the absent standup source decide?",
		needs: [{ id: "standup-2024-01-01", description: "required standup source is not in the bundle", required: true }],
		expected_action: "abstain",
		expected_support: [],
		forbidden: ["STANDUP-DECISION-ALPHA"],
		evidence_ids: ["agentsview:standup-2024-01-01"],
	},
	{
		id: "minimal-context",
		family: "minimal-context",
		prompt: "Which schema id and donor spill default are sufficient without replaying the tool transcript?",
		needs: [
			{ id: "schema", description: "schema id", required: true },
			{ id: "spill-bytes", description: "donor spill default", required: true },
		],
		expected_action: "answer",
		expected_support: ["z0int.context_resolve.v1", "RLM_DEFAULT_SPILL_BYTES = 20480"],
		forbidden: [],
		evidence_ids: ["z0int:context_resolve", "donor:pr-77:spill-bytes"],
	},
];

const QUESTION_BY_ID = new Map(FROZEN_QUESTIONS.map(question => [question.id, question]));

export function frozenQuestion(id: string): FrozenQuestion | undefined {
	return QUESTION_BY_ID.get(id);
}

export function matchFrozenQuestion(text: string): FrozenQuestion | undefined {
	const match = /z0evals#56:([a-z0-9-]+)/.exec(text);
	if (!match?.[1]) return undefined;
	return frozenQuestion(match[1]);
}
