import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const ledgerPath = path.join(repoRoot, "docs/z0-extension-seams.md");
const sourceSha = "31147f9d1a76608549821c3759f8487b4d66c72d";
const expectedAreas = ["Context", "Provider", "Tool", "Lifecycle", "Timers / jobs", "UI", "Reload"];
const sourceLink =
	/\[([^\]]+)\]\(https:\/\/github\.com\/kvnloo\/oh-my-pi\/blob\/([a-f0-9]{40})\/([^#)]+)#L(\d+)\)/g;

function seamRows(markdown: string): string[] {
	return markdown
		.split("\n")
		.filter(line => /^\| (?:Context|Provider|Tool|Lifecycle|Timers \/ jobs|UI|Reload) \|/.test(line));
}

describe("M5 extension seam ledger", () => {
	it("has one complete row for every required seam", async () => {
		const markdown = await Bun.file(ledgerPath).text();
		const rows = seamRows(markdown);
		expect(rows.map(row => row.split("|")[1]?.trim())).toEqual(expectedAreas);
		for (const row of rows) {
			const cells = row.split("|").slice(1, -1).map(cell => cell.trim());
			expect(cells).toHaveLength(6);
			expect(cells.every(cell => cell.length > 0)).toBe(true);
		}
		expect(markdown).toContain("GENERIC_UPSTREAM_CANDIDATE");
		expect(markdown).toContain("not an actual out-of-tree z0 adapter");
	});

	it("resolves every symbol and exact line against the immutable source snapshot", async () => {
		const markdown = await Bun.file(ledgerPath).text();
		const cache = new Map<string, string[]>();
		let checked = 0;

		for (const row of seamRows(markdown)) {
			const links = [...row.matchAll(sourceLink)];
			expect(links.length).toBeGreaterThanOrEqual(2);
			for (const [, rawLabel, revision, sourceFile, lineNumber] of links) {
				if (!rawLabel || !revision || !sourceFile || !lineNumber) {
					throw new Error("Missing source-link field");
				}
				expect(revision).toBe(sourceSha);
				expect(sourceFile).toMatch(/^packages\/coding-agent\/src\/extensibility\/[\w/.-]+\.ts$/);
				const absolute = path.resolve(repoRoot, sourceFile);
				expect(absolute.startsWith(repoRoot + path.sep)).toBe(true);
				let lines = cache.get(absolute);
				if (!lines) {
					lines = (await Bun.file(absolute).text()).split("\n");
					cache.set(absolute, lines);
				}
				const symbol = rawLabel.replaceAll(String.fromCharCode(96), "");
				expect(lines[Number(lineNumber) - 1]).toContain(symbol);
				checked++;
			}
		}
		expect(checked).toBeGreaterThanOrEqual(14);
	});
});
