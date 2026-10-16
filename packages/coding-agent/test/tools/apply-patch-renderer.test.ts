import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function getUiTheme() {
	await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	const theme = await themeModule.getThemeByName("dark");
	expect(theme).toBeDefined();
	return theme!;
}

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("apply_patch rendering", () => {
	it("renders apply_patch results through edit UI instead of generic fallback", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

		const component = new ToolExecutionComponent(
			"apply_patch",
			{
				input: "*** Begin Patch\n*** Update File: src/demo.ts\n@@\n-old\n+new\n*** End Patch",
			},
			{},
			undefined,
			uiStub,
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					path: "src/demo.ts",
					op: "update",
					diff: "@@\n-old\n+new",
				},
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(140).join("\n"));
		expect(rendered).toContain("src/demo.ts");
		expect(rendered).toContain("+new");
		expect(rendered).not.toContain("(no output)");
	});

	it("derives call path, operation, and file-count hints from apply_patch input", async () => {
		const uiTheme = await getUiTheme();
		const input = [
			"*** Begin Patch",
			"*** Update File: src/first.ts",
			"@@",
			"-before",
			"+after",
			"*** Add File: src/new.ts",
			"+hello",
			"*** End Patch",
		].join("\n");

		const component = toolRenderers.apply_patch.renderCall({ input }, { expanded: false, isPartial: true }, uiTheme);
		if (!component) throw new Error("expected a call component");
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/first.ts");
		expect(rendered).toContain("Edit");
		expect(rendered).toContain("(+1 more)");
	});

	it("does not show missing end-marker errors while apply_patch input is streaming", async () => {
		const uiTheme = await getUiTheme();
		const input = ["*** Begin Patch", "*** Update File: src/streaming.ts", "@@", "-before", "+after"].join("\n");

		const component = toolRenderers.apply_patch.renderCall({ input }, { expanded: false, isPartial: true }, uiTheme);
		if (!component) throw new Error("expected a call component");
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/streaming.ts");
		expect(rendered).not.toContain("The last line of the patch must be");
	});

	it("shows an apply_patch parse error preview for malformed input", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const malformedInput = ["*** Begin Patch", "*** Update File: src/bad.ts", "*** End Patch"].join("\n");

		const component = new ToolExecutionComponent("apply_patch", { input: malformedInput }, {}, undefined, uiStub);
		component.updateStreamPreview({
			generation: 1,
			streaming: false,
			files: [{ path: "", error: "Line 3: Update file hunk for path 'src/bad.ts' is empty" }],
		});
		const rendered = Bun.stripANSI(component.render(160).join("\n"));

		expect(rendered).toContain("src/bad.ts");
		expect(rendered).toContain("is empty");
	});

	it("shows apply_patch preview diffs after args complete", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-preview-"));
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const input = [
				"*** Begin Patch",
				"*** Update File: preview.ts",
				"@@",
				"-const value = 1;",
				"+const value = 2;",
				"*** End Patch",
			].join("\n");

			const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub, tmpDir);
			const before = Bun.stripANSI(component.render(160).join("\n"));
			expect(before).not.toContain("(preview)");

			component.updateStreamPreview({
				generation: 1,
				streaming: false,
				files: [
					{
						path: "preview.ts",
						diff: " 1|const value = 1;\n-1|const value = 1;\n+1|const value = 2;",
						firstChangedLine: 1,
					},
				],
			});
			component.setArgsComplete();
			const after = Bun.stripANSI(component.render(160).join("\n"));
			expect(after).toContain("(preview)");
			expect(after).toContain("const value = 2;");
		} finally {
			await removeWithRetries(tmpDir);
		}
	});

	it("reveals settled approval diffs without unbounding live or collapsed previews", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const input = ["*** Begin Patch", "*** Update File: preview.ts", "@@", "-before", "+after", "*** End Patch"].join("\n");
		const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub);
		const diff = [" 1|HEAD_APPROVAL_SENTINEL", ...Array.from({ length: 120 }, (_, i) => ` ${i + 2}|middle-${i}`), " 122|TAIL_APPROVAL_SENTINEL"].join("\n");
		const render = () => Bun.stripANSI(component.render(160).join("\n"));

		component.updateStreamPreview({ generation: 1, streaming: true, files: [{ path: "preview.ts", diff, firstChangedLine: 1 }] });
		component.setArgsComplete();
		component.setExpanded(true);
		const live = render();
		expect(live).toContain("… (content above)");
		expect(live).not.toContain("HEAD_APPROVAL_SENTINEL");
		expect(live).toContain("TAIL_APPROVAL_SENTINEL");

		component.updateStreamPreview({ generation: 2, streaming: false, files: [{ path: "preview.ts", diff, firstChangedLine: 1 }] });
		component.setExpanded(false);
		const collapsed = render();
		expect(collapsed).toContain("… (content above)");
		expect(collapsed).not.toContain("HEAD_APPROVAL_SENTINEL");
		expect(collapsed).toContain("TAIL_APPROVAL_SENTINEL");

		component.setExpanded(true);
		const expanded = render();
		expect(expanded).toContain("HEAD_APPROVAL_SENTINEL");
		expect(expanded).toContain("TAIL_APPROVAL_SENTINEL");
		expect(expanded).not.toContain("… (content above)");

		// A late live batch must not replace a terminal approval snapshot.
		component.updateStreamPreview({ generation: 3, streaming: true, files: [{ path: "preview.ts", diff: "HEAD_LATE_BATCH", firstChangedLine: 1 }] });
		expect(render()).toBe(expanded);
	});

	it("shows both files of a settled multi-file approval diff", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const input = ["*** Begin Patch", "*** Update File: first.ts", "@@", "-a", "+b", "*** Update File: second.ts", "@@", "-c", "+d", "*** End Patch"].join("\n");
		const component = new ToolExecutionComponent("apply_patch", { input }, {}, undefined, uiStub);
		const big = (head: string, tail: string) => [` 1|${head}`, ...Array.from({ length: 120 }, (_, i) => ` ${i + 2}|middle-${i}`), ` 122|${tail}`].join("\n");
		const files = [
			{ path: "first.ts", diff: big("HEAD_FIRST", "TAIL_FIRST"), firstChangedLine: 1 },
			{ path: "second.ts", diff: big("HEAD_SECOND", "TAIL_SECOND"), firstChangedLine: 1 },
		];
		component.updateStreamPreview({ generation: 1, streaming: true, files });
		component.setArgsComplete();
		component.setExpanded(true);
		const live = Bun.stripANSI(component.render(160).join("\n"));
		expect(live).not.toContain("HEAD_FIRST");
		expect(live).not.toContain("HEAD_SECOND");
		component.updateStreamPreview({ generation: 2, streaming: false, files });
		const settled = Bun.stripANSI(component.render(160).join("\n"));
		for (const marker of ["HEAD_FIRST", "TAIL_FIRST", "HEAD_SECOND", "TAIL_SECOND"]) expect(settled).toContain(marker);
		expect(settled).not.toContain("… (content above)");
	});

	it("refreshes streaming preview immediately on arg updates without scheduling a debounce", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "apply-patch-instant-preview-"));
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		try {
			await Bun.write(path.join(tmpDir, "preview.ts"), "const value = 1;\n");
			const component = new ToolExecutionComponent("apply_patch", { input: "" }, {}, undefined, uiStub, tmpDir);

			setTimeoutSpy.mockClear();
			component.updateArgs({
				input: [
					"*** Begin Patch",
					"*** Update File: preview.ts",
					"@@",
					"-const value = 1;",
					"+const value = 2;",
					"*** End Patch",
				].join("\n"),
			});

			expect(setTimeoutSpy).not.toHaveBeenCalled();
		} finally {
			setTimeoutSpy.mockRestore();
			await removeWithRetries(tmpDir);
		}
	});

	it("aligns rendered edit diff separators", async () => {
		await getUiTheme();
		const uiStub = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"edit",
			{ path: "packages/coding-agent/src/tools/image-gen.ts" },
			{},
			undefined,
			uiStub,
		);

		component.updateResult(
			{
				content: [{ type: "text", text: "" }],
				details: {
					path: "packages/coding-agent/src/tools/image-gen.ts",
					op: "update",
					diff: [
						" 10|}",
						'+11|import { CODEX_INSTRUCTIONS } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";',
						" 12|\t$env,",
						" 228|\toutput_format: typeof OPENAI_IMAGE_OUTPUT_FORMAT;",
						"+235|\tinstructions?: string;",
						' 234|\tinput: Array<{ role: "user"; content: OpenAIInputContent[] }>;',
					].join("\n"),
				},
			},
			false,
		);

		const rendered = Bun.stripANSI(component.render(220).join("\n"));
		expect(rendered).toContain("  10│}");
		expect(rendered).toContain(" +11│import");
		expect(rendered).toContain(" 228│");
		expect(rendered).toContain("+235│");
		expect(rendered).toContain(" 234│");
	});
});
