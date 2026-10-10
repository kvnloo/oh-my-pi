import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { CollapsedSyntheticMessageComponent } from "../source/packages/tui/src/chat/user-message";
import { initTheme } from "../source/packages/tui/src/theme";

// Fixed expectations and Intl segmentation are independent of truncateToWidth.
beforeAll(async () => {
	await initTheme(false);
});

const live: CollapsedSyntheticMessageComponent[] = [];
afterEach(() => {
	for (const component of live) component.dispose();
	live.length = 0;
});

function component(heading: string): CollapsedSyntheticMessageComponent {
	const c = new CollapsedSyntheticMessageComponent(`# ${heading}\nbody`);
	live.push(c);
	return c;
}

function visible(c: CollapsedSyntheticMessageComponent, width: number): string {
	return Bun.stripANSI(c.render(width)[0]!);
}

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
function expectedHeading(heading: string, width: number): string {
	const budget = Math.max(10, Math.max(1, width) - 1) - 1;
	let cells = 0;
	let prefix = "";
	for (const { segment } of segmenter.segment(heading)) {
		const size = Bun.stringWidth(segment);
		if (cells + size > budget) break;
		cells += size;
		prefix += segment;
	}
	return ` ${prefix}…`;
}

// Widths in this suite clip inside a deliberately long heading, before metadata.
const clusters = [
	["ZWJ technologist", "👩‍💻"],
	["ZWJ family", "👨‍👩‍👧‍👦"],
	["skin-tone modifier", "👍🏽"],
	["regional indicator flag", "🇺🇸"],
	["combining acute accent", "e\u0301"],
	["emoji variation selector", "❤️"],
	["keycap sequence", "1️⃣"],
	["CJK wide character", "界"],
] as const;

describe("independent collapsed summary controls", () => {
	it("renders a complete technologist at the original failing boundary", () => {
		expect(visible(component("abcdef👩‍💻tail"), 11)).toBe(" abcdef👩‍💻t…");
	});

	for (const [name, cluster] of clusters) {
		it(`keeps ${name} whole at every nearby clipping boundary`, () => {
			const heading = `abcdefgh${cluster}${"tail".repeat(10)}`;
			const c = component(heading);
			for (const width of [11, 12, 13, 14, 15]) {
				const actual = visible(c, width);
				expect(actual).toBe(expectedHeading(heading, width));
				expect(Bun.stringWidth(actual)).toBeLessThanOrEqual(width);
			}
		});
	}

	it("retains the ASCII and CJK fixed clipping controls", () => {
		expect(visible(component("abcdefghijklmnopqrstuvwxyz"), 11)).toBe(" abcdefghi…");
		expect(visible(component("abcdefg界tail"), 11)).toBe(" abcdefg界…");
		expect(visible(component("abcdefgh界tail"), 11)).toBe(" abcdefgh…");
	});

	it("keeps ANSI SGR sequences complete around a clipped grapheme", () => {
		const plain = component("abcdefgh👩‍💻tailtailtail");
		for (const heading of [
			"\x1b[31mabcdefgh👩‍💻tailtailtail\x1b[0m",
			"abcdefgh\x1b[31m👩‍💻tailtailtail\x1b[0m",
		]) {
			const c = component(heading);
			for (const width of [11, 12, 13, 14]) {
				const raw = c.render(width)[0]!;
				expect(Bun.stripANSI(raw)).toBe(visible(plain, width));
				expect(Bun.stripANSI(raw)).not.toContain("\x1b");
			}
		}
	});

	it("keeps the full untruncated label and metadata", () => {
		const output = visible(component("Hello"), 200);
		expect(output).toContain("Hello");
		expect(output).toContain("2 lines");
		expect(output).not.toContain("…");
	});

	it("renders empty and no-heading input with the fallback summary", () => {
		for (const [input, count] of [["", "0 lines"], ["plain body", "1 line"]]) {
			const c = new CollapsedSyntheticMessageComponent(input);
			live.push(c);
			const full = visible(c, 200);
			expect(full).toContain("Synthetic input");
			expect(full).toContain(count!);
			expect(visible(c, 11)).toBe(" Synthetic…");
		}
	});

	it("does not conflate the fix with the existing small-width floor", () => {
		const c = component("abcdefghijklmnopqrstuvwxyz");
		for (const width of [0, 1, 10]) {
			const actual = visible(c, width);
			expect(actual).toBe(" abcdefghi…");
			expect(Bun.stringWidth(actual)).toBe(11);
		}
	});

	it("survives resize, cache invalidation, release, expansion and recollapse", () => {
		const c = component("abcdef👩‍💻tail");
		const wide = visible(c, 120);
		expect(visible(c, 11)).toBe(" abcdef👩‍💻t…");
		expect(visible(c, 11)).toBe(" abcdef👩‍💻t…");
		expect(visible(c, 120)).toBe(wide);
		c.invalidate();
		expect(visible(c, 11)).toBe(" abcdef👩‍💻t…");
		c.releaseRenderCaches();
		expect(visible(c, 11)).toBe(" abcdef👩‍💻t…");
		c.setExpanded(true);
		const expanded = c.render(120).map((row) => Bun.stripANSI(row)).join("\n");
		expect(expanded).toContain("body");
		c.setExpanded(false);
		expect(visible(c, 11)).toBe(" abcdef👩‍💻t…");
	});
});
