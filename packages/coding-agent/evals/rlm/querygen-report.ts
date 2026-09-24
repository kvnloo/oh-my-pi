#!/usr/bin/env bun
/** Report for RLM query-generation experiment. */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.join(import.meta.dir, "results", "querygen.jsonl");

type Arm = "oracle" | "lexical" | "model";
interface Row {
	run: number;
	arm: Arm;
	model: string;
	workload: string;
	patterns: string[];
	patternHits: number;
	retrievalPass: boolean;
	fullBytes: number;
	grantedBytes: number;
	grantRatio: number;
	generatorInputTokens?: number;
	generatorOutputTokens?: number;
	generatorTotalTokens?: number;
	generatorElapsedMs: number;
	systemTokenProxy: number;
}

if (!fs.existsSync(OUT)) {
	console.error("missing " + OUT + " — run bun evals/rlm/querygen-orchestrate.ts");
	process.exit(1);
}
const rows = fs
	.readFileSync(OUT, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(line => JSON.parse(line) as Row);

function mean(xs: number[]): number {
	return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}
function pct(x: number): string {
	return (x * 100).toFixed(1) + "%";
}
function summarize(arm: Arm) {
	const a = rows.filter(r => r.arm === arm);
	const tokenRows = a.filter(r => r.generatorTotalTokens !== undefined);
	return {
		arm,
		n: a.length,
		passRate: a.length === 0 ? 0 : a.filter(r => r.retrievalPass).length / a.length,
		avgPatterns: mean(a.map(r => r.patterns.length)),
		avgPatternHits: mean(a.map(r => r.patternHits)),
		avgGrantBytes: mean(a.map(r => r.grantedBytes)),
		avgGrantRatio: mean(a.map(r => r.grantRatio)),
		avgGeneratorTokens:
			tokenRows.length === 0 ? undefined : mean(tokenRows.map(r => r.generatorTotalTokens!)),
		avgGeneratorMs: mean(a.map(r => r.generatorElapsedMs)),
		avgSystemTokenProxy: mean(a.map(r => r.systemTokenProxy)),
		avgFullTokenProxy: mean(a.map(r => Math.ceil(r.fullBytes / 4))),
	};
}

const present = (["oracle", "lexical", "model"] as Arm[]).filter(arm => rows.some(r => r.arm === arm));
const summaries = present.map(summarize);

console.log("RLM query-generation experiment");
console.log("rows=" + rows.length + " model=" + (rows.find(r => r.arm === "model")?.model ?? "not-run"));
console.log("");
for (const s of summaries) {
	const savings =
		s.avgFullTokenProxy === 0 ? 0 : 1 - s.avgSystemTokenProxy / s.avgFullTokenProxy;
	console.log(
		[
			s.arm.padEnd(8),
			"retrieval=" + pct(s.passRate),
			"patterns=" + s.avgPatterns.toFixed(1),
			"hits=" + s.avgPatternHits.toFixed(1),
			"grant=" + Math.round(s.avgGrantBytes) + "B",
			"grant/full=" + pct(s.avgGrantRatio),
			s.avgGeneratorTokens === undefined ? "" : "gen_tokens=" + s.avgGeneratorTokens.toFixed(1),
			"system_token_proxy=" + s.avgSystemTokenProxy.toFixed(1),
			"proxy_savings=" + pct(savings),
			s.arm === "model" ? "gen_latency=" + s.avgGeneratorMs.toFixed(1) + "ms" : "",
		]
			.filter(Boolean)
			.join(" "),
	);
}

console.log("");
const workloads = [...new Set(rows.map(r => r.workload))];
for (const workload of workloads) {
	const line = present.map(arm => {
		const a = rows.filter(r => r.workload === workload && r.arm === arm);
		const rate = a.length === 0 ? 0 : a.filter(r => r.retrievalPass).length / a.length;
		const example = a[0]?.patterns ?? [];
		return arm + "=" + pct(rate) + " " + JSON.stringify(example);
	});
	console.log(workload);
	for (const part of line) console.log("  " + part);
}

const oracle = summarize("oracle");
const lexical = summarize("lexical");
let failed = 0;
console.log("");
if (oracle.passRate !== 1) {
	console.log("FAIL oracle retrieval is not 100%; fixture/search policy is broken");
	failed++;
} else {
	console.log("PASS oracle retrieval is 100%");
}
if (lexical.n === 0) {
	console.log("FAIL lexical baseline missing");
	failed++;
} else {
	console.log("PASS lexical baseline present");
}

const model = rows.some(r => r.arm === "model") ? summarize("model") : null;
if (!model) {
	console.log("");
	console.log("model arm not run; set RLM_QUERYGEN_LIVE=1 to answer the actual query-generation question.");
	if (failed) process.exit(1);
	process.exit(0);
}

console.log("");
const oracleRetention = oracle.passRate === 0 ? 0 : model.passRate / oracle.passRate;
const beatsLexical = model.passRate >= lexical.passRate;
const candidate = oracleRetention >= 0.8 && beatsLexical;
console.log("model/oracle retrieval retention=" + pct(oracleRetention));
console.log("model-vs-lexical delta=" + pct(model.passRate - lexical.passRate));
console.log(
	candidate
		? "CANDIDATE: query generation clears the provisional >=80% oracle-retention bar and does not trail lexical."
		: "NOT READY: improve/query-test retrieval formation before adding RLM runtime architecture.",
);
console.log("This gate is provisional; repeat across models and real traces before any upstream architecture claim.");

if (failed) process.exit(1);
