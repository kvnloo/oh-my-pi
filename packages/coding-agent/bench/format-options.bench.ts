/**
 * Actual formatting-options helper cost with frozen public-source fixtures.
 *
 * Run: bun packages/coding-agent/bench/format-options.bench.ts <corpus.json> <oracle.json>
 * Capture the output oracle before edits by appending --capture-oracles.
 * Warm p95 describes batched sample averages, not end-user operation latency.
 * Cold means a fresh editorconfig metadata-cache directory; OS caches are not reset.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LspFormattingOptions, resolveFormatOptions } from "../src/lsp/format-options";

interface Fixture {
	file: string;
	bytes: number;
	sha256: string;
}

interface Scenario {
	id: string;
	config: string;
	content: string;
	primary?: boolean;
}

interface Corpus {
	base: string;
	corpus: Record<string, Fixture>;
	configs: Record<string, { body: string | null }>;
	warmCases: Scenario[];
	coldCases: Scenario[];
	protocol: { rounds: number; warmupCalls: number; coldSamples: number };
}

const manifestPath = Bun.argv[2];
const oraclePath = Bun.argv[3];
if (!manifestPath || !oraclePath) throw new Error("Pass frozen corpus and oracle JSON paths");
const manifest = (await Bun.file(manifestPath).json()) as Corpus;
const texts = new Map<string, string>();
for (const [id, fixture] of Object.entries(manifest.corpus)) {
	const content = await Bun.file(path.join(path.dirname(manifestPath), "corpus", fixture.file)).text();
	if (Buffer.byteLength(content) !== fixture.bytes || Bun.SHA256.hash(content, "hex") !== fixture.sha256) {
		throw new Error(`Fixture hash or byte count changed: ${id}`);
	}
	texts.set(id, content);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-format-bench-"));
const capture = Bun.argv.includes("--capture-oracles");
const oracle: Record<string, LspFormattingOptions> = capture
	? {}
	: ((await Bun.file(oraclePath).json()) as Record<string, LspFormattingOptions>);
let checksum = 0;

function verify(id: string, actual: LspFormattingOptions): void {
	if (capture) {
		if (oracle[id] && JSON.stringify(actual) !== JSON.stringify(oracle[id])) {
			throw new Error(`Warm/cold formatting request disagreement for ${id}`);
		}
		oracle[id] = actual;
		return;
	}
	if (JSON.stringify(actual) !== JSON.stringify(oracle[id])) {
		throw new Error(`Formatting request changed for ${id}: ${JSON.stringify(actual)}`);
	}
}

function percentile(samples: readonly number[], fraction: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function prepare(dir: string, config: string): Promise<string> {
	await fs.mkdir(dir, { recursive: true });
	const body = manifest.configs[config]!.body;
	if (body !== null) await Bun.write(path.join(dir, ".editorconfig"), body);
	return path.join(dir, "fixture.ts");
}

try {
	// A no-declaration root bounds ancestor traversal in the missing-config control.
	await Bun.write(path.join(root, ".editorconfig"), "root = true\n");
	const warmPaths = new Map<string, string>();
	for (const config of Object.keys(manifest.configs)) {
		warmPaths.set(config, await prepare(path.join(root, "warm", config), config));
	}
	for (const scenario of manifest.warmCases) {
		const filePath = warmPaths.get(scenario.config)!;
		const content = texts.get(scenario.content)!;
		verify(scenario.id, resolveFormatOptions(filePath, content));
		if (capture) continue;
		for (let i = 0; i < manifest.protocol.warmupCalls; i++) resolveFormatOptions(filePath, content);
		const bytes = manifest.corpus[scenario.content]!.bytes;
		const loops = Math.max(3, Math.min(1000, Math.floor(1_000_000 / Math.max(1, bytes))));
		const samplesMs: number[] = [];
		for (let round = 0; round < manifest.protocol.rounds; round++) {
			Bun.gc(true);
			let result: LspFormattingOptions | undefined;
			const start = Bun.nanoseconds();
			for (let i = 0; i < loops; i++) {
				result = resolveFormatOptions(filePath, content);
				checksum += result.tabSize + (result.insertSpaces ? 1 : 0);
			}
			const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
			verify(scenario.id, result!);
			samplesMs.push(elapsedMs / loops);
		}
		console.log(
			JSON.stringify({
				mode: "warm",
				id: scenario.id,
				bytes,
				loops,
				medianMs: percentile(samplesMs, 0.5),
				batchP95Ms: percentile(samplesMs, 0.95),
				samplesMs,
			}),
		);
	}
	let coldIndex = 0;
	for (const scenario of manifest.coldCases) {
		const content = texts.get(scenario.content)!;
		const samplesMs: number[] = [];
		for (let sample = 0; sample < (capture ? 1 : manifest.protocol.coldSamples); sample++) {
			// Each sample has a fresh parent directory, not merely a new filename.
			const dir = path.join(root, "cold", String(coldIndex++).padStart(4, "0"));
			const filePath = await prepare(dir, scenario.config);
			if (capture) {
				verify(scenario.id, resolveFormatOptions(filePath, content));
				continue;
			}
			Bun.gc(true);
			const start = Bun.nanoseconds();
			const result = resolveFormatOptions(filePath, content);
			const elapsedMs = (Bun.nanoseconds() - start) / 1e6;
			checksum += result.tabSize + (result.insertSpaces ? 1 : 0);
			verify(scenario.id, result);
			samplesMs.push(elapsedMs);
		}
		if (!capture)
			console.log(
				JSON.stringify({
					mode: "cold-metadata",
					id: scenario.id,
					bytes: manifest.corpus[scenario.content]!.bytes,
					medianMs: percentile(samplesMs, 0.5),
					sampleP95Ms: percentile(samplesMs, 0.95),
					samplesMs,
				}),
			);
	}
	if (capture) {
		await Bun.write(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`);
		console.log(JSON.stringify({ capturedOracles: Object.keys(oracle).length }));
	} else {
		const tiny = oracle["complete-space/tiny-yaml"];
		if (checksum <= 0 || tiny?.tabSize !== 2 || tiny.insertSpaces !== true) throw new Error("Invalid consumption");
		console.log(JSON.stringify({ checksum, maxRssKiB: process.resourceUsage().maxRSS }));
	}
} finally {
	await fs.rm(root, { recursive: true, force: true });
}
