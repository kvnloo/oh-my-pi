/**
 * Regression for #15197: generic repaints (`invalidate()`) expired the settled
 * PR context, so every agent event re-ran `gh pr view`. Ordinary activity must
 * reuse a recently settled lookup; explicit Git invalidation still refetches.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { StatusLineSettings } from "@oh-my-pi/pi-tui/status-line";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

// HEAD on a feature branch so `#isDefaultBranch("feature/x")` returns false
// (the sync seed is "main"), letting `#lookupPr` reach the gh call.
const fakeRefHead: VcsHeadState = {
	kind: "ref",
	branch: "feature/x",
	refName: "refs/heads/feature/x",
	commit: undefined,
};
const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	isReftable: false,
};

const gitSegmentSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "pr-lookup-throttle test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

beforeEach(() => {
	vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
	const gitRepository = {
		defaultBranch: async () => "main",
		headSync: () => fakeRefHead,
		linkedWorktree: () => null,
	} as unknown as VcsGitRepo;
	vi.spyOn(vcs, "git").mockReturnValue(gitRepository);
	const repository = {
		kind: () => "git",
		asGit: () => gitRepository,
		asJj: () => null,
		root: () => fakeRepoInfo.repoRoot,
		watchTarget: () => fakeRepoInfo.headPath,
	} as unknown as VcsRepo;
	vi.spyOn(vcs, "repo").mockReturnValue(repository);
	// The render path resolves the branch through the display detector first;
	// left unstubbed it finds the real checkout and caches its branch.
	vi.spyOn(vcs, "repoForDisplay").mockReturnValue(repository);
	// Bypass the delayed default-branch resolver used by `#isDefaultBranch`;
	// synchronous seed of "main" is enough to make the check return false.
});

afterEach(() => {
	vi.restoreAllMocks();
});

const prJson = JSON.stringify({ number: 42, url: "https://github.com/x/y/pull/42" });

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function countGhCalls() {
	return vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: prJson, stderr: "" });
}

describe("StatusLineComponent PR lookup throttle (#15197)", () => {
	it("spawns gh pr view at most once for 3 activity ticks within 1s", async () => {
		const ghRun = countGhCalls();
		const component = new StatusLineComponent(makeSession(), statusLineHost);
		component.updateSettings(gitSegmentSettings);
		try {
			component.getTopBorder(80);
			await settle();
			for (let tick = 0; tick < 3; tick++) {
				component.invalidate();
				component.getTopBorder(80);
				await settle();
			}
			expect(ghRun.mock.calls.length).toBeLessThanOrEqual(1);
		} finally {
			component.dispose();
		}
	});

	it("refetches immediately after an explicit Git invalidation", async () => {
		const ghRun = countGhCalls();
		const component = new StatusLineComponent(makeSession(), statusLineHost);
		component.updateSettings(gitSegmentSettings);
		try {
			component.getTopBorder(80);
			await settle();
			component.invalidateGitCaches();
			component.getTopBorder(80);
			await settle();
			expect(ghRun.mock.calls.length).toBe(2);
		} finally {
			component.dispose();
		}
	});

	it("refetches on activity once the settled lookup is older than the refresh interval", async () => {
		const ghRun = countGhCalls();
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const component = new StatusLineComponent(makeSession(), statusLineHost);
		component.updateSettings(gitSegmentSettings);
		try {
			component.getTopBorder(80);
			await settle();
			now += 60_000;
			component.invalidate();
			component.getTopBorder(80);
			await settle();
			expect(ghRun.mock.calls.length).toBe(2);
		} finally {
			component.dispose();
		}
	});
});
