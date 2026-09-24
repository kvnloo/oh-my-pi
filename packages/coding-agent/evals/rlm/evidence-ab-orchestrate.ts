#!/usr/bin/env bun
/**
 * Clean RLM evidence-selection A/B.
 *
 * This is intentionally eval-only: no production code, router, membrane, or
 * provider-policy changes. It isolates one question:
 *
 *   Given the same task and the same 8 KiB evidence budget, does choosing
 *   relevant ranges beat always granting the first 8 KiB?
 *
 * Arms:
 *   native   - full corpus
 *   fixed8k  - first QUERY_SLICE bytes/chars
 *   search8k - literal-search-selected ranges capped to QUERY_SLICE bytes
 *
 * Default mode is deterministic mechanism validation. Set RLM_BENCH_LIVE=1
 * for an OpenAI-compatible live model.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUERY_SLICE, RlmStore } from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "evidence-ab.jsonl");
const LIVE = process.env.RLM_BENCH_LIVE === "1";
const RUNS = Math.max(1, Number.parseInt(process.env.RLM_BENCH_RUNS || "1", 10) || 1);
const BASE_URL = (process.env.RLM_BENCH_BASE_URL || process.env.VLLM_UPSTREAM || "http://127.0.0.1:8000").replace(/\/$/, "");
const MODEL = process.env.RLM_BENCH_MODEL || process.env.VLLM_MODEL || "Qwen/Qwen2.5-1.5B-Instruct";
const API_KEY = process.env.RLM_BENCH_API_KEY || "";
const SEARCH_CONTEXT = Math.max(32, Number.parseInt(process.env.RLM_BENCH_SEARCH_CONTEXT || "512", 10) || 512);

type Arm = "native" | "fixed8k" | "search8k";

interface Workload {
	id: string;
	description: string;
	task: string;
	corpus: string;
	patterns: string[];
	expected: string[];
}

interface Range {
	start: number;
	end: number;
}

interface ModelResult {
	text: string;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	elapsedMs: number;
}

interface Row {
	ts: number;
	run: number;
	backend: "mechanism" | "live";
	model: string;
	workload: string;
	description: string;
	arm: Arm;
	pass: boolean;
	answer: string;
	expected: string[];
	fullBytes: number;
	grantedBytes: number;
	grantRatio: number;
	promptBytes: number;
	ranges: Range[];
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	elapsedMs: number;
}

function filler(tag: string, chars: number): string {
	const line = "[" + tag + "] routine trace event: state=ok owner=session payload=unchanged\n";
	return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
}

const work = (() => {
	const head = "HEAD_SYMBOL=normalizeResolvedPath";
	const tail = "root_cause=LEASE_EXPIRED_AFTER_DISPOSE";
	const typeA = "TYPE_EXPECTED=AuthConfig";
	const typeB = "RUNTIME_ACTUAL=string";
	const cfg = "CONFIG_RETRY_LIMIT=5";
	const runtime = "RUNTIME_RETRY_LIMIT=2";

	const workloads: Workload[] = [
		{
			id: "head-control",
			description: "Control: useful evidence is already inside the first 8 KiB.",
			task: "Return the exact HEAD_SYMBOL value.",
			corpus: head + "\n" + filler("head", 28_000),
			patterns: ["HEAD_SYMBOL="],
			expected: ["normalizeResolvedPath"],
		},
		{
			id: "tail-root-cause",
			description: "Root cause appears well beyond the fixed first slice.",
			task: "Return the exact root_cause token.",
			corpus: filler("tail-pre", 24_000) + "\nERROR " + tail + " detail=cleanup-order\n" + filler("tail-post", 4_000),
			patterns: ["root_cause="],
			expected: ["LEASE_EXPIRED_AFTER_DISPOSE"],
		},
		{
			id: "cross-region-contract",
			description: "Two decision-critical facts live in distant regions.",
			task: "Return TYPE_EXPECTED and RUNTIME_ACTUAL exactly.",
			corpus:
				filler("type-pre", 11_000) +
				"\n" + typeA + "\n" +
				filler("type-mid", 15_000) +
				"\n" + typeB + "\n" +
				filler("type-post", 4_000),
			patterns: ["TYPE_EXPECTED=", "RUNTIME_ACTUAL="],
			expected: ["AuthConfig", "string"],
		},
		{
			id: "runtime-contradiction",
			description: "Config and runtime disagree; both values are required.",
			task: "Return both CONFIG_RETRY_LIMIT and RUNTIME_RETRY_LIMIT exactly.",
			corpus:
				filler("cfg-pre", 10_000) +
				"\n" + cfg + "\n" +
				filler("cfg-mid", 16_000) +
				"\n" + runtime + "\n" +
				filler("cfg-post", 3_000),
			patterns: ["CONFIG_RETRY_LIMIT=", "RUNTIME_RETRY_LIMIT="],
			expected: ["CONFIG_RETRY_LIMIT=5", "RUNTIME_RETRY_LIMIT=2"],
		},
	];
	return workloads;
})();

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
		const bytes = Buffer.byteLength(body.slice(range.start, mid), "utf8");
		if (bytes <= maxBytes) lo = mid;
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

function searchRanges(store: RlmStore, handle: string, body: string, patterns: string[]): Range[] {
	const raw: Range[] = [];
	for (const pattern of patterns) {
		for (const hit of store.search(handle, pattern, 2, "literal")) {
			raw.push({
				start: Math.max(0, hit.index - SEARCH_CONTEXT),
				end: Math.min(body.length, hit.index + pattern.length + SEARCH_CONTEXT),
			});
		}
	}
	return capRanges(body, mergeRanges(raw), QUERY_SLICE);
}

function rangesForArm(store: RlmStore, handle: string, workload: Workload, arm: Arm): Range[] {
	if (arm === "native") return [{ start: 0, end: workload.corpus.length }];
	if (arm === "fixed8k") return [{ start: 0, end: Math.min(workload.corpus.length, QUERY_SLICE) }];
	return searchRanges(store, handle, workload.corpus, workload.patterns);
}

function evidenceForRanges(workload: Workload, ranges: Range[]): string {
	return ranges
		.map((range, i) => {
			const citation = "evidence[" + range.start + ":" + range.end + "]";
			return "### grant-" + (i + 1) + " " + citation + "\n" + workload.corpus.slice(range.start, range.end);
		})
		.join("\n\n");
}

function buildPrompt(workload: Workload, evidence: string): string {
	return [
		"You are an evidence worker.",
		"Answer ONLY from the authorized evidence below.",
		"Return the exact requested token(s) with no explanation.",
		"",
		"Authorized evidence:",
		evidence,
		"",
		"Task:",
		workload.task,
	].join("\n");
}

function containsExpected(text: string, expected: string[]): boolean {
	return expected.every(token => text.includes(token));
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (API_KEY) headers.Authorization = "Bearer " + API_KEY;
	return headers;
}

async function liveComplete(prompt: string): Promise<ModelResult> {
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
		}),
	});
	if (!res.ok) throw new Error("bench provider " + res.status + ": " + (await res.text()).slice(0, 300));
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
		usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
	};
	return {
		text: json.choices?.[0]?.message?.content ?? "",
		promptTokens: json.usage?.prompt_tokens,
		completionTokens: json.usage?.completion_tokens,
		totalTokens: json.usage?.total_tokens,
		elapsedMs: performance.now() - t0,
	};
}

async function checkLive(): Promise<void> {
	const res = await fetch(BASE_URL + "/v1/models", { headers: authHeaders() });
	if (!res.ok) throw new Error("bench provider unavailable at " + BASE_URL + " (" + res.status + ")");
}

async function runOne(workload: Workload, arm: Arm, run: number): Promise<Row> {
	const store = new RlmStore({ maxDepth: 1, maxCalls: 16, maxTotalTokens: 2_000_000 });
	const record = store.put(workload.corpus, workload.id);
	const handle = record.id;
	const ranges = rangesForArm(store, handle, workload, arm);
	const evidence = evidenceForRanges(workload, ranges);
	const prompt = buildPrompt(workload, evidence);
	const fullBytes = Buffer.byteLength(workload.corpus, "utf8");
	const grantedBytes = Buffer.byteLength(evidence, "utf8");

	let answer: string;
	let elapsedMs = 0;
	let promptTokens: number | undefined;
	let completionTokens: number | undefined;
	let totalTokens: number | undefined;

	if (LIVE) {
		const result = await liveComplete(prompt);
		answer = result.text;
		elapsedMs = result.elapsedMs;
		promptTokens = result.promptTokens;
		completionTokens = result.completionTokens;
		totalTokens = result.totalTokens;
	} else {
		const missing = workload.expected.filter(token => !evidence.includes(token));
		answer = missing.length === 0 ? "<mechanism-pass>" : "<mechanism-miss:" + missing.join(",") + ">";
	}

	const pass = LIVE ? containsExpected(answer, workload.expected) : containsExpected(evidence, workload.expected);
	return {
		ts: Date.now(),
		run,
		backend: LIVE ? "live" : "mechanism",
		model: LIVE ? MODEL : "none",
		workload: workload.id,
		description: workload.description,
		arm,
		pass,
		answer: answer.slice(0, 500),
		expected: workload.expected,
		fullBytes,
		grantedBytes,
		grantRatio: fullBytes === 0 ? 0 : grantedBytes / fullBytes,
		promptBytes: Buffer.byteLength(prompt, "utf8"),
		ranges,
		promptTokens,
		completionTokens,
		totalTokens,
		elapsedMs,
	};
}

async function main(): Promise<void> {
	if (LIVE) await checkLive();
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

	for (let run = 1; run <= RUNS; run++) {
		for (const workload of work) {
			for (const arm of ["native", "fixed8k", "search8k"] as const) {
				const row = await runOne(workload, arm, run);
				fs.appendFileSync(OUT, JSON.stringify(row) + "\n");
				console.log(
					[
						"run=" + run,
						"workload=" + workload.id,
						"arm=" + arm,
						"pass=" + row.pass,
						"bytes=" + row.grantedBytes + "/" + row.fullBytes,
						LIVE ? "tokens=" + (row.totalTokens ?? "?") : "backend=mechanism",
					].join(" "),
				);
			}
		}
	}
	console.log("wrote " + OUT);
	console.log("next: bun evals/rlm/evidence-ab-report.ts");
}

await main();
