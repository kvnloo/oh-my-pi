import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { getThemeByName } from "../source/packages/tui/src/theme/loader";
import type { Theme } from "../source/packages/tui/src/theme/theme-class";
import {
	describeShimmer,
	setShimmerMode,
	shimmerSegments,
	type ShimmerPalette,
} from "../source/packages/tui/src/theme/shimmer";
import { isNativeRendering, setNativeRendering } from "../source/packages/tui/src/native/state";
import { createVibeToolRenderer, type VibeToolDetails } from "../source/packages/tui/src/tools/vibe";

// This oracle does not import getSegmenter, truncateToWidth, or shimmer internals.
const oracle = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const originalNow = Date.now;
const initialNativeRendering = isNativeRendering();
const plain = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
// Existing vibe label sanitization replaces ZWJ (Cf) with a space. For these
// fixed fixtures only, account for that independent preprocessing contract.
const vibeDisplay = (value: string): string => value.replaceAll("\u200d", " ");
const palette: ShimmerPalette = {
	low: { ansi: "\x1b[31m" },
	mid: { ansi: "\x1b[32m" },
	high: { ansi: "\x1b[34m" },
};
const alternatePalette: ShimmerPalette = {
	low: { ansi: "\x1b[35m" },
	mid: { ansi: "\x1b[36m" },
	high: { ansi: "\x1b[33m" },
	bold: true,
};
let uiTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("Built-in dark theme did not load");
	uiTheme = loaded;
});

afterEach(() => {
	vi.restoreAllMocks();
	setShimmerMode("classic");
	setNativeRendering(initialNativeRendering);
	expect(Date.now).toBe(originalNow);
});

function generatedSgrOffsets(value: string): number[] {
	const offsets: number[] = [];
	let escapedLength = 0;
	for (const match of value.matchAll(/\x1b\[[0-9;]*m/g)) {
		offsets.push(match.index - escapedLength);
		escapedLength += match[0].length;
	}
	return offsets;
}

function assertWholeStyledGraphemes(value: string, source: string): void {
	expect(plain(value)).toBe(source);
	const boundaries = new Set([0, source.length]);
	for (const { index } of oracle.segment(source)) boundaries.add(index);
	for (const offset of generatedSgrOffsets(value)) expect(boundaries.has(offset)).toBe(true);
}

function expectedTruncation(source: string, width: number): string {
	if (Bun.stringWidth(source) <= width) return source;
	let out = "";
	let cells = 0;
	for (const { segment } of oracle.segment(source)) {
		const next = Bun.stringWidth(segment);
		if (cells + next > width - 1) break;
		out += segment;
		cells += next;
	}
	return `${out}…`;
}

function makeWait(toolArgs: string, spinnerFrame?: number) {
	const details: VibeToolDetails = {
		op: "wait",
		screens: [{
			id: "Anna", cli: "fast", state: "running", turns: 1, queued: 0,
			trace: [], outputTail: [], lastActivityAt: 0,
			currentTool: "read", currentToolArgs: toolArgs,
		}],
		wait: { settled: [], stillRunning: ["Anna"], timedOut: false, waiting: true },
	};
	return createVibeToolRenderer("wait").renderResult(
		{ content: [{ type: "text", text: "" }], details },
		{ expanded: false, isPartial: true, spinnerFrame },
		uiTheme,
		{ sessions: ["Anna"] },
	);
}

function forbidExternalWork(): void {
	vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Renderer attempted fetch"); });
	vi.spyOn(Bun, "spawn").mockImplementation(() => { throw new Error("Renderer attempted process spawn"); });
	vi.spyOn(Bun, "spawnSync").mockImplementation(() => { throw new Error("Renderer attempted synchronous spawn"); });
	vi.spyOn(Bun, "serve").mockImplementation(() => { throw new Error("Renderer attempted server startup"); });
}

const clusters = [
	["ZWJ profession", "👩‍💻"],
	["variation selector", "❤️"],
	["combining mark", "e\u0301"],
	["regional-indicator flag", "🇺🇳"],
	["family ZWJ chain", "👨‍👩‍👧‍👦"],
	["skin-tone modifier", "👍🏽"],
] as const;

describe("independent shimmer grapheme boundary contract", () => {
	for (const mode of ["classic", "kitt"] as const) {
		for (const [name, cluster] of clusters) {
			it(`${mode}: never inserts generated SGR inside ${name} as the band passes`, () => {
				setShimmerMode(mode);
				const clock = vi.spyOn(Date, "now").mockReturnValue(467);
				const source = `read: ${cluster}tail`;
				for (const now of [467, ...Array.from({ length: 82 }, (_, i) => i * 37)]) {
					clock.mockReturnValue(now);
					assertWholeStyledGraphemes(shimmerSegments([{ text: source, palette }], uiTheme), source);
				}
			});
		}
	}

	it("chooses the first code point's tier and advances subsequent text by original code-point count", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(467);
		// At 467 ms, positions 6/7/8/9 have high/mid/mid/low intensity.
		// The emoji covers 6..8, so its whole glyph is high; t at 9 is low.
		const output = shimmerSegments([{ text: "read: 👩‍💻tail", palette }], uiTheme);
		expect(output).toContain("\x1b[34m");
		expect(output).toContain("👩‍💻\x1b[39m\x1b[31mtail");
		assertWholeStyledGraphemes(output, "read: 👩‍💻tail");
	});

	it("retains exact ASCII tier placement at the fixed regression frame", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(467);
		expect(shimmerSegments([{ text: "read: ABCtail", palette }], uiTheme)).toBe(
			"\x1b[32mre\x1b[39m\x1b[34mad: A\x1b[39m\x1b[32mBC\x1b[39m\x1b[31mtail\x1b[39m",
		);
	});

	it("retains separate palettes when adjacent semantic segments split a grapheme", () => {
		setShimmerMode("classic");
		vi.spyOn(Date, "now").mockReturnValue(0);
		const output = shimmerSegments([
			{ text: "👩", palette },
			{ text: "‍💻", palette: alternatePalette },
		], uiTheme);
		expect(output).toBe("\x1b[31m👩\x1b[39m\x1b[35m‍💻\x1b[39m");
	});

	it("keeps an all-empty animation empty and preserves disabled empty-segment palette emission", () => {
		for (const mode of ["classic", "kitt", "disabled"] as const) {
			setShimmerMode(mode);
			expect(shimmerSegments([{ text: "", palette }, { text: "", palette: alternatePalette }], uiTheme)).toBe("");
		}
		setShimmerMode("disabled");
		expect(shimmerSegments([
			{ text: "", palette }, { text: "👩‍💻", palette: alternatePalette }, { text: "", palette },
		], uiTheme)).toBe("\x1b[32m\x1b[39m\x1b[36m👩‍💻\x1b[39m\x1b[32m\x1b[39m");
	});

	it("leaves native/TSP payloads and terminal-clocked descriptors unchanged", () => {
		setNativeRendering(true);
		const segments = [{ text: "👩‍💻", palette }, { text: "❤️" }];
		for (const mode of ["classic", "kitt", "disabled"] as const) {
			setShimmerMode(mode);
			expect(shimmerSegments(segments, uiTheme)).toBe("👩‍💻❤️");
			expect(describeShimmer(segments, "fixture")).toEqual({
				k: mode === "disabled" ? "text" : "shimmer",
				p: mode === "disabled"
					? { spans: [{ t: "👩‍💻" }, { t: "❤️", s: "muted" }] }
					: { spans: [{ t: "👩‍💻" }, { t: "❤️", s: "muted" }], mode, palette: {} },
				c: undefined,
				key: "fixture",
			});
		}
	});
});

describe("independent real wait-renderer contract", () => {
	for (const [name, cluster] of clusters) {
		it(`renders ${name} input with existing preprocessing and whole-grapheme clipping`, () => {
			forbidExternalWork();
			setShimmerMode("classic");
			vi.spyOn(Date, "now").mockReturnValue(467);
			const component = makeWait(`${cluster}tail`, 0);
			const full = `${uiTheme.boxRound.vertical} ${uiTheme.tree.hook} read: ${vibeDisplay(cluster)}tail`;
			const railWidth = Bun.stringWidth(`${uiTheme.boxRound.vertical} ${uiTheme.tree.hook} `);
			for (const width of [6, 7, 8, 9, 10, 11, 12, 100].map(n => n + railWidth)) {
				const rows = component.render(width);
				const raw = rows.find(row => plain(row).includes("read"));
				if (raw === undefined) throw new Error(`Missing current tool row at width ${width}`);
				const expected = expectedTruncation(full, width);
				expect(plain(raw)).toBe(expected);
				expect(Bun.stringWidth(plain(raw))).toBeLessThanOrEqual(width);
				assertWholeStyledGraphemes(raw, expected);
				for (const row of rows) expect(Bun.stringWidth(plain(row))).toBeLessThanOrEqual(width);
			}
		});
	}

	it("preserves ASCII, empty args, disabled animation, and stable rendering controls", () => {
		forbidExternalWork();
		const clock = vi.spyOn(Date, "now").mockReturnValue(467);
		for (const args of ["", "packages/coding-agent/src/theme/shimmer.ts", "👩‍💻tail", "a👩‍💻b❤️céd🇺🇳e👍🏽f"]) {
			for (const mode of ["classic", "disabled"] as const) {
				setShimmerMode(mode);
				for (const frame of [undefined, 0]) {
					// Animated Unicode is the regression group above, not a baseline control.
					if (mode === "classic" && frame === 0 && /[^\x00-\x7f]/.test(args)) continue;
					const component = makeWait(args, frame);
					const full = `${uiTheme.boxRound.vertical} ${uiTheme.tree.hook} read${args ? `: ${vibeDisplay(args)}` : ""}`;
					for (const width of [14, 40, 100]) {
						clock.mockReturnValue(467);
						const first = component.render(width).find(row => plain(row).includes("read"));
						if (first === undefined) throw new Error("Missing control row");
						expect(plain(first)).toBe(expectedTruncation(full, width));
						if (frame === undefined || mode === "disabled") {
							clock.mockReturnValue(967);
							const second = component.render(width).find(row => plain(row).includes("read"));
							expect(second).toBe(first);
						}
					}
				}
			}
		}
	});
});
