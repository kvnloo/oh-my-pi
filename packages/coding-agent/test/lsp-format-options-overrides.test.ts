import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveFormatOptions } from "@oh-my-pi/pi-coding-agent/lsp/format-options";

describe("formatting requests with incomplete editorconfig overrides", () => {
	let root = "";
	const space4 = "root:\n    child:\n        leaf: value\n";

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-format-overrides-"));
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	async function resolve(declaration: string, content = space4) {
		await Bun.write(path.join(root, ".editorconfig"), `root = true\n[*]\n${declaration}\n`);
		return resolveFormatOptions(path.join(root, "fixture.ts"), content);
	}

	it("keeps the content's width when only the style is configured", async () => {
		const options = await resolve("indent_style = tab");
		expect(options.tabSize).toBe(4);
		expect(options.insertSpaces).toBe(false);
	});

	it("keeps a configured space style while detecting its missing width", async () => {
		const options = await resolve("indent_style = space");
		expect(options.tabSize).toBe(4);
		expect(options.insertSpaces).toBe(true);
	});

	it("detects tab style when only the display width is configured", async () => {
		const options = await resolve("tab_width = 8", "root:\n\tchild: value\n");
		expect(options.tabSize).toBe(8);
		expect(options.insertSpaces).toBe(false);
	});

	it("still detects width for indent_size = tab without tab_width", async () => {
		const options = await resolve("indent_size = tab");
		expect(options.tabSize).toBe(4);
		expect(options.insertSpaces).toBe(false);
	});

	it("ignores invalid or zero declarations and uses content indentation", async () => {
		const options = await resolve("indent_style = unknown\nindent_size = 0\ntab_width = bad");
		expect(options.tabSize).toBe(4);
		expect(options.insertSpaces).toBe(true);
	});

	it("uses content indentation when the complete section does not match the target", async () => {
		await Bun.write(path.join(root, ".editorconfig"), "root = true\n[*.py]\nindent_size = 8\nindent_style = tab\n");
		const options = resolveFormatOptions(path.join(root, "fixture.ts"), space4);
		expect(options.tabSize).toBe(4);
		expect(options.insertSpaces).toBe(true);
	});

	it("preserves inherited values when nested declarations are invalid or unset", async () => {
		await Bun.write(path.join(root, ".editorconfig"), "root = true\n[*]\nindent_size = 6\nindent_style = tab\n");
		await Bun.write(path.join(root, "child", ".editorconfig"), "[*]\nindent_size = 0\nindent_style = unset\n");
		const options = resolveFormatOptions(path.join(root, "child", "fixture.ts"), space4);
		expect(options.tabSize).toBe(6);
		expect(options.insertSpaces).toBe(false);
	});
});
