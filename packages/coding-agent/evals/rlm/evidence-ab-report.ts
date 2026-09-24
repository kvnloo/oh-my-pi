#!/usr/bin/env bun
/** Report for the clean RLM evidence-selection A/B. */
import * as fs from "node:fs";
import * as path from "node:path";
import { QUERY_SLICE } from "../../src/rlm";

const OUT = path.join(import.meta.dir, "results", "evidence-ab.jsonl");

type Arm = "native" | "fixed8k" | "search8k";

interface Row {
	run: number;
	backend: "mechanism" | "live";
	model: string;
	workload: string;
	arm: Arm;
	pass: boolean;
	fullBytes: number;
	grantedBytes: number;
	grantRatio: number;
	promptBytes: number;
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	elapsedMs: number;
}

if (!fs.existsSync(OUT)) {
	console.error("missing " + OUT + " — run bun evals/rlm/evidence-ab-orchestrate.ts");
	process.exit(1);
}

const rows = fs
	.readFileSync(OUT, "utf8")
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(line => JSON.parse(line) as Row);

if (rows.length === 0) {
	console.error("no rows");
	process.exit(1);
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(n: number): string {
	return (n * 100).toFixed(1) + "%";
}

const arms: Arm[] = ["native", "fixed8k", "search8k"];
const summary = arms.map(arm => {
	const a = rows.filter(row => row.arm === arm);
	const withTokens = a.map(row => row.totalTokens).filter((v): v is number => v !== undefined);
	return {
		arm,
		rows: a.length,
		passRate: a.length === 0 ? 0 : a.filter(row => row.pass).length / a.length,
		avgGrantedBytes: mean(a.map(row => row.grantedBytes)),
		avgGrantRatio: mean(a.map(row => row.grantRatio)),
		avgPromptBytes: mean(a.map(row => row.promptBytes)),
		avgTotalTokens: withTokens.length === 0 ? undefined : mean(withTokens),
		avgElapsedMs: mean(a.map(row => row.elapsedMs)),
	};
});

console.log("RLM evidence-selection A/B");
console.log("backend=" + rows[0]!.backend + " model=" + rows[0]!.model + " rows=" + rows.length);
console.log("");
for (const s of summary) {
	console.log(
		[
			s.arm.padEnd(9),
			"pass=" + pct(s.passRate),
			"grant=" + Math.round(s.avgGrantedBytes) + "B",
			"grant/full=" + pct(s.avgGrantRatio),
			"prompt=" + Math.round(s.avgPromptBytes) + "B",
			s.avgTotalTokens === undefined ? "" : "tokens=" + s.avgTotalTokens.toFixed(1),
			rows[0]!.backend === "live" ? "latency=" + s.avgElapsedMs.toFixed(1) + "ms" : "",
		]
			.filter(Boolean)
			.join(" "),
	);
}

console.log("");
const workloads = [...new Set(rows.map(row => row.workload))];
for (const workload of workloads) {
	const w = rows.filter(row => row.workload === workload);
	const parts = arms.map(arm => {
		const a = w.filter(row => row.arm === arm);
		const pass = a.length === 0 ? 0 : a.filter(row => row.pass).length / a.length;
		return arm + "=" + pct(pass);
	});
	console.log(workload.padEnd(28) + " " + parts.join(" "));
}

const backend = rows[0]!.backend;
if (backend === "mechanism") {
	let failed = 0;
	const native = rows.filter(row => row.arm === "native");
	const fixed = rows.filter(row => row.arm === "fixed8k");
	const search = rows.filter(row => row.arm === "search8k");

	const nativeAll = native.every(row => row.pass);
	const searchAll = search.every(row => row.pass);
	const searchCap = search.every(row => row.grantedBytes <= QUERY_SLICE + 256);
	const exposesFixedFailure = workloads.some(workload => {
		const f = fixed.filter(row => row.workload === workload);
		const s = search.filter(row => row.workload === workload);
		return f.some(row => !row.pass) && s.every(row => row.pass);
	});
	const searchRatio = mean(search.map(row => row.grantRatio));
	const compressionGate = searchRatio <= 0.35;

	const gates = [
		["native evidence contains all expected facts", nativeAll],
		["search-selected evidence contains all expected facts", searchAll],
		["search-selected grants stay near the 8 KiB cap", searchCap],
		["at least one fixed-first-slice miss is recovered by search", exposesFixedFailure],
		["mean search evidence is <=35% of full evidence", compressionGate],
	] as const;

	console.log("");
	for (const [name, ok] of gates) {
		console.log((ok ? "PASS " : "FAIL ") + name);
		if (!ok) failed++;
	}
	if (failed) process.exit(1);
	console.log("");
	console.log("mechanism conclusion: fixed position is not a sufficient evidence policy; selection is load-bearing.");
} else {
	const fixed = summary.find(s => s.arm === "fixed8k")!;
	const search = summary.find(s => s.arm === "search8k")!;
	console.log("");
	console.log(
		"live delta search-vs-fixed: pass " +
			pct(search.passRate - fixed.passRate) +
			", grant bytes " +
			Math.round(search.avgGrantedBytes - fixed.avgGrantedBytes) +
			", tokens " +
			(search.avgTotalTokens !== undefined && fixed.avgTotalTokens !== undefined
				? (search.avgTotalTokens - fixed.avgTotalTokens).toFixed(1)
				: "n/a"),
	);
	console.log("live runs are descriptive; do not promote architecture from a single model/sample.");
}
