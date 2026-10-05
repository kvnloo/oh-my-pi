import { beforeAll, expect, spyOn, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Component, TUI } from "../src/tui";
import { showGitOverlay } from "../src/apps/git/git-tui";
import type { ChangedFile, GitTuiModel } from "../src/apps/git/state";
import { initTheme } from "../src/theme/theme";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});

for (const area of ["commit", "unstaged", "staged"] as const) {
	test(`git ${area} view advertises only applicable mutation hints`, async () => {
		const file: ChangedFile = { path: "ordinary.txt", kind: "modified", area };
		const tui = new TUI(new VirtualTerminal(400, 24));
		const selected = Promise.withResolvers<void>();
		let component: Component | undefined;
		const originalShow = tui.showOverlay.bind(tui);
		const overlaySpy = spyOn(tui, "showOverlay").mockImplementation((view, options) => {
			component = view;
			return originalShow(view, options);
		});
		const renderSpy = spyOn(tui, "requestRender").mockImplementation(() => {});
		const mutations: string[] = [];
		const model: GitTuiModel = {
			cwd: "/synthetic-repo",
			branch: "main",
			clean: area === "commit",
			unstaged: area === "unstaged" ? [file] : [],
			staged: area === "staged" ? [file] : [],
			headCommit:
				area === "commit"
					? {
							sha: "1234567",
							shortSha: "1234567",
							subject: "Ordinary committed change",
							body: "",
							authorName: "Fixture",
							authorEmail: "fixture@example.invalid",
							authorDate: "2026-10-05T00:00:00Z",
							parents: [],
							files: [file],
							filesLoaded: true,
						}
					: null,
			refresh: async () => false,
			loadChangeStats: async () => false,
			loadHeadFiles: async () => false,
			streamContents: async () => {
				selected.resolve();
				return { kind: "asset", old: { kind: "binary" }, new: { kind: "binary" } };
			},
			stage: async () => {
				mutations.push("stage");
			},
			unstage: async () => {
				mutations.push("unstage");
			},
			discard: async () => {
				mutations.push("discard");
			},
			commit: async () => {
				mutations.push("commit");
			},
			applyPatch: async () => {
				mutations.push("patch");
			},
		};
		const closed = showGitOverlay(tui, {
			model,
			createAvatarSource: () => ({ get: () => null }),
			aiStage: async () => {
				throw new Error("unexpected AI staging");
			},
			generateCommitMessage: async () => {
				throw new Error("unexpected generation");
			},
		});
		try {
			await selected.promise;
			expect(component).toBeDefined();
			if (!component) throw new Error("overlay was not mounted");
			for (const focus of ["sidebar", "diff"] as const) {
				if (focus === "diff") component.handleInput?.("\t");
				const header = stripVTControlCharacters(component.render(400)[0]);
				expect(header).toContain("ordinary.txt");
				expect(header).toContain("quit");
				if (area === "commit") {
					expect(header).not.toContain(" stage");
					expect(header).not.toContain(" discard");
				} else {
					expect(header).toContain(" stage");
					expect(header).toContain(" discard");
				}
			}
			expect(mutations).toEqual([]);
		} finally {
			component?.handleInput?.("q");
			await closed;
			overlaySpy.mockRestore();
			renderSpy.mockRestore();
			tui.stop();
		}
	});
}
