#!/usr/bin/env bun
/**
 * RLM query-generation experiment.
 *
 * Question:
 *   Can a cheap model turn only the task + the existing RLM stub metadata into
 *   literal search patterns that recover decision-critical evidence?
 *
 * The generator NEVER sees the hidden corpus or oracle patterns.
 *
 * Arms:
 *   oracle  - workload-authored patterns (upper bound only)
 *   lexical - deterministic near-zero-cost baseline from task + stub preview
 *   model   - live OpenAI-compatible model from task + stub preview
 *
 * This eval stops at retrieval sufficiency. It intentionally does not run an
 * evidence worker, so query formation is measured without answer-generation
 * quality as a confounder.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUERY_SLICE, RlmStore, stubFor } from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "querygen.jsonl");
const LIVE = process.env.RLM_QUERYGEN_LIVE === "1";
const RUNS = Math.max(1, Number.parseInt(process.env.RLM_QUERYGEN_RUNS || "1", 10) || 1);
const BASE_URL = (
	process.env.RLM_QUERYGEN_BASE_URL ||
	process.env.RLM_BENCH_BASE_URL ||
	process.env.VLLM_UPSTREAM ||
	"http://127.0.0.1:8000"
).replace(/\/$/, "");
const MODEL =
	process.env.RLM_QUERYGEN_MODEL ||
	process.env.RLM_BENCH_MODEL ||
	process.env.VLLM_MODEL ||
	"Qwen/Qwen2.5-1.5B-Instruct";
const API_KEY = process.env.RLM_QUERYGEN_API_KEY || process.env.RLM_BENCH_API_KEY || "";
const MAX_PATTERNS = 4;
const SEARCH_CONTEXT = 512;

type Arm = "oracle" | "lexical" | "model";

interface Workload {
	id: string;
	source: string;
	description: string;
	task: string;
	corpus: string;
	oraclePatterns: string[];
	expected: string[];
}

interface Range {
	start: number;
	end: number;
}

interface Generation {
	patterns: string[];
	raw: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	elapsedMs: number;
}

interface Row {
	ts: number;
	run: number;
	arm: Arm;
	model: string;
	workload: string;
	description: string;
	task: string;
	source: string;
	patterns: string[];
	patternHits: number;
	retrievalPass: boolean;
	expected: string[];
	fullBytes: number;
	grantedBytes: number;
	grantRatio: number;
	ranges: Range[];
	stubBytes: number;
	generatorInputBytes: number;
	generatorInputTokens?: number;
	generatorOutputTokens?: number;
	generatorTotalTokens?: number;
	generatorElapsedMs: number;
	systemTokenProxy: number;
	rawGeneration?: string;
}

function filler(tag: string, chars: number): string {
	const line = "[" + tag + "] routine trace event state=ok owner=session payload=unchanged\n";
	return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

function workloads(): Workload[] {
	return [
		{
			id: "head-control",
			source: "symbols.txt",
			description: "Control: requested identifier is already near the head.",
			task: "What is the HEAD_SYMBOL value?",
			corpus: "HEAD_SYMBOL=normalizeResolvedPath\n" + filler("head", 28_000),
			oraclePatterns: ["HEAD_SYMBOL="],
			expected: ["normalizeResolvedPath"],
		},
		{
			id: "mid-root-cause",
			source: "agent-runtime.log",
			description: "Failure cause is in the middle, outside stub head/tail preview.",
			task: "What root cause caused the worker cleanup failure?",
			corpus:
				filler("cleanup-start", 14_000) +
				"\nworker cleanup failed root_cause=LEASE_EXPIRED_AFTER_DISPOSE phase=dispose\n" +
				filler("cleanup-end", 14_000),
			oraclePatterns: ["root_cause="],
			expected: ["LEASE_EXPIRED_AFTER_DISPOSE"],
		},
		{
			id: "cross-region-type-contract",
			source: "typecheck.log",
			description: "Expected type and runtime value are in separate regions.",
			task: "Which type was expected, and what runtime type was actually received?",
			corpus:
				filler("types-a", 10_000) +
				"\nvalidation contract TYPE_EXPECTED=AuthConfig field=auth\n" +
				filler("types-b", 13_000) +
				"\nruntime mismatch RUNTIME_ACTUAL=string field=auth\n" +
				filler("types-c", 5_000),
			oraclePatterns: ["TYPE_EXPECTED=", "RUNTIME_ACTUAL="],
			expected: ["AuthConfig", "string"],
		},
		{
			id: "runtime-config-contradiction",
			source: "diagnostics.log",
			description: "Configured and observed retry limits disagree.",
			task: "Compare the configured retry limit with the retry limit actually used at runtime.",
			corpus:
				filler("retry-a", 9_000) +
				"\nsettings snapshot CONFIG_RETRY_LIMIT=5 source=user\n" +
				filler("retry-b", 14_000) +
				"\nrequest trace RUNTIME_RETRY_LIMIT=2 source=effective-policy\n" +
				filler("retry-c", 5_000),
			oraclePatterns: ["CONFIG_RETRY_LIMIT=", "RUNTIME_RETRY_LIMIT="],
			expected: ["CONFIG_RETRY_LIMIT=5", "RUNTIME_RETRY_LIMIT=2"],
		},
		{
			id: "semantic-ownership",
			source: "lifecycle.log",
			description: "Natural-language task must produce a useful ownership anchor.",
			task: "Which component owns cleanup after cancellation?",
			corpus:
				filler("owner-a", 12_000) +
				"\ncancellation cleanup ownership dispose_owner=AgentSession lifecycle=terminal\n" +
				filler("owner-b", 16_000),
			oraclePatterns: ["cleanup ownership", "dispose_owner="],
			expected: ["AgentSession"],
		},
		{
			id: "ordering-boundary",
			source: "events.log",
			description: "Task asks about event ordering rather than a known schema key.",
			task: "What happens immediately before the worker abort event?",
			corpus:
				filler("event-a", 15_000) +
				"\nevent ordering before_worker_abort=lease_cancel then=worker_abort\n" +
				filler("event-b", 13_000),
			oraclePatterns: ["before_worker_abort=", "worker_abort"],
			expected: ["lease_cancel"],
		},
	];
}

function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

function normalizePatterns(patterns: readonly string[]): string[] {
	return unique(
		patterns
			.map(p => p.trim())
			.filter(p => p.length >= 2 && p.length <= 64)
			.filter(p => !p.includes("\n")),
	).slice(0, MAX_PATTERNS);
}

const STOP = new Set([
	"what",
	"which",
	"where",
	"when",
	"who",
	"why",
	"how",
	"does",
	"did",
	"with",
	"from",
	"into",
	"that",
	"this",
	"then",
	"than",
	"were",
	"was",
	"actually",
	"used",
	"value",
	"event",
	"after",
	"before",
	"immediately",
]);

/**
 * Cheap baseline with the same task + stub inputs as the model.
 * Task tokens are preferred; preview tokens only fill unused slots.
 */
function lexicalPatterns(task: string, preview: string): string[] {
	const quoted = [...task.matchAll(/[`'"]([A-Za-z0-9_.:-]{2,64})[`'"]/g)].map(m => m[1]!);
	const identifierish = [...task.matchAll(/\b[A-Z][A-Z0-9_]{2,63}\b/g)].map(m => m[0]);
	const taskWords = (task.match(/[A-Za-z][A-Za-z0-9_-]{3,63}/g) ?? [])
		.filter(w => !STOP.has(w.toLowerCase()))
		.sort((a, b) => {
			const score = (v: string) => (v.includes("_") ? 4 : 0) + (/[A-Z]/.test(v) ? 2 : 0) + Math.min(v.length, 16) / 16;
			return score(b) - score(a);
		});
	const taskPhrase = taskWords
		.filter(w => /^[A-Za-z]+$/.test(w))
		.slice(0, 2)
		.join("_");
	const variants = taskPhrase
		? [taskPhrase.toLowerCase(), taskPhrase.toUpperCase()]
		: [];

	const previewWords = (preview.match(/[A-Za-z][A-Za-z0-9_.:-]{4,63}/g) ?? [])
		.filter(w => !STOP.has(w.toLowerCase()))
		.filter(w => !/^(routine|trace|state|owner|session|payload|unchanged)$/i.test(w));

	return normalizePatterns([...quoted, ...identifierish, ...variants, ...taskWords, ...previewWords]);
}

function mergeRanges(input: Range[]): Range[] {
	if (input.length === 0) return [];
	const sorted = [...input].sort((a, b) => a.start - b.start || a.end - b.end);
	const out: Range[] = [{ ...sorted[0]! }];
	for (const cur of sorted.slice(1)) {
		const last = out[out.length - 1]!;
		if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
		else out.push({ ...cur });
	}
	return out;
}

function shrinkRangeToBytes(body: string, range: Range, maxBytes: number): Range | null {
	if (maxBytes <= 0 || range.start >= range.end) return null;
	let lo = range.start;
	let hi = range.end;
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2);
		if (Buffer.byteLength(body.slice(range.start, mid), "utf8") <= maxBytes) lo = mid;
		else hi = mid - 1;
	}
	return lo > range.start ? { start: range.start, end: lo } : null;
}

function capRanges(body: string, ranges: Range[], maxBytes: number): Range[] {
	const out: Range[] = [];
	let used = 0;
	for (const range of ranges) {
		const bytes = Buffer.byteLength(body.slice(range.start, range.end), "utf8");
		if (used + bytes <= maxBytes) {
			out.push(range);
			used += bytes;
			continue;
		}
		const shrunk = shrinkRangeToBytes(body, range, maxBytes - used);
		if (shrunk) out.push(shrunk);
		break;
	}
	return out;
}

function selectEvidence(
	store: RlmStore,
	handle: string,
	body: string,
	patterns: readonly string[],
): { ranges: Range[]; patternHits: number } {
	const raw: Range[] = [];
	let patternHits = 0;
	for (const pattern of normalizePatterns(patterns)) {
		const hits = store.search(handle, pattern, 2, "literal");
		if (hits.length > 0) patternHits++;
		for (const hit of hits) {
			raw.push({
				start: Math.max(0, hit.index - SEARCH_CONTEXT),
				end: Math.min(body.length, hit.index + pattern.length + SEARCH_CONTEXT),
			});
		}
	}
	return { ranges: capRanges(body, mergeRanges(raw), QUERY_SLICE), patternHits };
}

function evidenceText(body: string, ranges: readonly Range[]): string {
	return ranges.map(r => body.slice(r.start, r.end)).join("\n\n");
}

function generatorPrompt(task: string, source: string, preview: string): string {
	return [
		"You generate literal search patterns for a hidden tool result.",
		"Return JSON only: {\"patterns\":[\"...\"]}.",
		"Choose 1-4 short strings likely to occur verbatim in the hidden result.",
		"Prefer identifiers, log keys, field names, and compact semantic anchors.",
		"Do not invent the answer. Do not use regex. Each pattern must be <=64 characters.",
		"",
		"Task:",
		task,
		"",
		"Source:",
		source,
		"",
		"RLM stub preview (head + tail only):",
		preview,
	].join("\n");
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (API_KEY) headers.Authorization = "Bearer " + API_KEY;
	return headers;
}

function parsePatterns(raw: string): string[] {
	const trimmed = raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
	try {
		const parsed = JSON.parse(trimmed) as { patterns?: unknown };
		if (!Array.isArray(parsed.patterns)) return [];
		return normalizePatterns(parsed.patterns.filter((p): p is string => typeof p === "string"));
	} catch {
		const strings = [...trimmed.matchAll(/"([^"\n]{2,64})"/g)].map(m => m[1]!);
		return normalizePatterns(strings.filter(s => s !== "patterns"));
	}
}

async function generateWithModel(prompt: string): Promise<Generation> {
	const t0 = performance.now();
	const res = await fetch(BASE_URL + "/v1/chat/completions", {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			model: MODEL,
			messages: [{ role: "user", content: prompt }],
			max_tokens: 96,
			temperature: 0,
			stream: false,
			response_format: { type: "json_object" },
		}),
	});
	if (!res.ok) throw new Error("querygen provider " + res.status + ": " + (await res.text()).slice(0, 300));
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	};
	const raw = json.choices?.[0]?.message?.content ?? "";
	return {
		patterns: parsePatterns(raw),
		raw,
		inputTokens: json.usage?.prompt_tokens,
		outputTokens: json.usage?.completion_tokens,
		totalTokens: json.usage?.total_tokens,
		elapsedMs: performance.now() - t0,
	};
}

async function checkLive(): Promise<void> {
	const res = await fetch(BASE_URL + "/v1/models", { headers: authHeaders() });
	if (!res.ok) throw new Error("querygen provider unavailable at " + BASE_URL + " (" + res.status + ")");
}

async function runArm(workload: Workload, arm: Arm, run: number): Promise<Row> {
	const store = new RlmStore();
	const record = store.put(workload.corpus, workload.source);
	const stub = stubFor(record);
	const prompt = generatorPrompt(workload.task, workload.source, stub.preview);

	let generation: Generation;
	if (arm === "oracle") {
		generation = { patterns: workload.oraclePatterns, raw: "<oracle>", elapsedMs: 0 };
	} else if (arm === "lexical") {
		generation = {
			patterns: lexicalPatterns(workload.task, stub.preview),
			raw: "<deterministic-lexical>",
			elapsedMs: 0,
		};
	} else {
		generation = await generateWithModel(prompt);
	}

	const selected = selectEvidence(store, record.id, workload.corpus, generation.patterns);
	const evidence = evidenceText(workload.corpus, selected.ranges);
	const fullBytes = Buffer.byteLength(workload.corpus, "utf8");
	const grantedBytes = Buffer.byteLength(evidence, "utf8");
	const retrievalPass = workload.expected.every(token => evidence.includes(token));
	const generatorTokens = generation.totalTokens ?? 0;
	const systemTokenProxy = generatorTokens + Math.ceil(grantedBytes / 4);

	return {
		ts: Date.now(),
		run,
		arm,
		model: arm === "model" ? MODEL : "none",
		workload: workload.id,
		description: workload.description,
		task: workload.task,
		source: workload.source,
		patterns: generation.patterns,
		patternHits: selected.patternHits,
		retrievalPass,
		expected: workload.expected,
		fullBytes,
		grantedBytes,
		grantRatio: fullBytes === 0 ? 0 : grantedBytes / fullBytes,
		ranges: selected.ranges,
		stubBytes: Buffer.byteLength(stub.stub, "utf8"),
		generatorInputBytes: arm === "model" ? Buffer.byteLength(prompt, "utf8") : 0,
		generatorInputTokens: generation.inputTokens,
		generatorOutputTokens: generation.outputTokens,
		generatorTotalTokens: generation.totalTokens,
		generatorElapsedMs: generation.elapsedMs,
		systemTokenProxy,
		rawGeneration: arm === "model" ? generation.raw.slice(0, 500) : undefined,
	};
}

async function main(): Promise<void> {
	if (LIVE) await checkLive();
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	const arms: Arm[] = LIVE ? ["oracle", "lexical", "model"] : ["oracle", "lexical"];
	for (let run = 1; run <= RUNS; run++) {
		for (const workload of workloads()) {
			for (const arm of arms) {
				const row = await runArm(workload, arm, run);
				fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
				console.log(
					[
						"run=" + run,
						"workload=" + workload.id,
						"arm=" + arm,
						"pass=" + row.retrievalPass,
						"patterns=" + JSON.stringify(row.patterns),
						"hits=" + row.patternHits,
						"grant=" + row.grantedBytes + "B",
						row.generatorTotalTokens === undefined ? "" : "gen_tokens=" + row.generatorTotalTokens,
					]
						.filter(Boolean)
						.join(" "),
				);
			}
		}
	}
	console.log("wrote " + OUT);
	console.log("next: bun evals/rlm/querygen-report.ts");
}

await main();
