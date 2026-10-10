import { getThemeByName } from "../source/packages/tui/src/theme/loader";
import { setShimmerMode, shimmerText } from "../source/packages/tui/src/theme/shimmer";
import { createVibeToolRenderer, type VibeToolDetails } from "../source/packages/tui/src/tools/vibe";

// Workload strings frozen in frozen-contract.md before candidate inspection.
const helperInputs = {
	ascii: "Reading package.json and updating renderer output",
	unicode: "Reading 👩‍💻 src/❤️/é/🇺🇳/👍🏽/👨‍👩‍👧‍👦.ts",
};
const rendererInputs = {
	ascii: "packages/coding-agent/src/theme/shimmer.ts",
	unicode: "src/👩‍💻/❤️/é/🇺🇳/👍🏽/👨‍👩‍👧‍👦.ts",
};
const uiTheme = await getThemeByName("dark");
if (!uiTheme) throw new Error("Built-in dark theme unavailable");
const originalNow = Date.now;
let now = 467;
let checksum = 0;
const helperIterations = Number(process.env.SHIMMER_HELPER_ITERATIONS ?? "20000");
const rendererIterations = Number(process.env.SHIMMER_RENDER_ITERATIONS ?? "2000");
const warmupIterations = Number(process.env.SHIMMER_WARMUP_ITERATIONS ?? "1000");
const rounds = Number(process.env.SHIMMER_ROUNDS ?? "5");
const records: Array<{ workload: string; iterations: number; round: number; nsPerOp: number }> = [];
const jobs: Array<{ workload: string; iterations: number; run: (i: number) => void; mode: "classic" | "disabled" }> = [];

for (const [name, input] of Object.entries(helperInputs)) {
	for (const mode of ["classic", "disabled"] as const) {
		jobs.push({
			workload: `helper/${name}/${mode}`, mode, iterations: helperIterations,
			run(i) {
				now = 467 + (i % 100) * 40;
				checksum += shimmerText(input, uiTheme).length;
			},
		});
	}
}
for (const [name, toolArgs] of Object.entries(rendererInputs)) {
	for (const width of [40, 100]) {
		for (const kind of ["animated", "stable", "disabled"] as const) {
			const details: VibeToolDetails = {
				op: "wait",
				screens: [{
					id: "Anna", cli: "fast", state: "running", turns: 1, queued: 0,
					trace: [], outputTail: [], lastActivityAt: 0,
					currentTool: "read", currentToolArgs: toolArgs,
				}],
				wait: { settled: [], stillRunning: ["Anna"], timedOut: false, waiting: true },
			};
			const options = { expanded: false, isPartial: true, spinnerFrame: kind === "stable" ? undefined : 0 };
			const component = createVibeToolRenderer("wait").renderResult(
				{ content: [{ type: "text", text: "" }], details }, options, uiTheme, { sessions: ["Anna"] },
			);
			jobs.push({
				workload: `renderer/${name}/${width}/${kind}`,
				mode: kind === "disabled" ? "disabled" : "classic",
				iterations: rendererIterations,
				run(i) {
					now = 467 + (i % 100) * 40;
					if (kind !== "stable") options.spinnerFrame = i % 24;
					const rows = component.render(width);
					for (const row of rows) checksum += row.length;
				},
			});
		}
	}
}

try {
	Date.now = () => now;
	for (const job of jobs) {
		setShimmerMode(job.mode);
		for (let i = 0; i < warmupIterations; i++) job.run(i);
	}
	for (let round = 0; round < rounds; round++) {
		const ordered = round % 2 === 0 ? jobs : [...jobs].reverse();
		for (const job of ordered) {
			setShimmerMode(job.mode);
			const start = performance.now();
			for (let i = 0; i < job.iterations; i++) job.run(i);
			const ms = performance.now() - start;
			records.push({ workload: job.workload, iterations: job.iterations, round, nsPerOp: ms * 1e6 / job.iterations });
		}
	}
} finally {
	Date.now = originalNow;
	setShimmerMode("classic");
}
if (Date.now !== originalNow) throw new Error("Clock was not restored");
console.log(JSON.stringify({
	bun: Bun.version, helperIterations, rendererIterations, warmupIterations, rounds,
	helperInputs, rendererInputs, checksum, records,
}));
