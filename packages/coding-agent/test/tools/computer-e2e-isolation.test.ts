import { describe, expect, test } from "bun:test";
import {
	buildGatedHyprExecExpression,
	e2eIsolationChildEnv,
	mergeE2eIsolationEnv,
	readE2eIsolationTarget,
} from "../../src/tools/computer/e2e-isolation";
import { HyprlandStageManager, type HyprctlResult, type HyprctlRunner } from "../../src/tools/computer/stage-manager";
import { ToolError } from "../../src/tools/tool-errors";

describe("e2e isolation helpers", () => {
	test("readE2eIsolationTarget requires both monitor and workspace", () => {
		expect(readE2eIsolationTarget({})).toBeNull();
		expect(readE2eIsolationTarget({ OMP_E2E_MONITOR: "HEADLESS" })).toBeNull();
		expect(readE2eIsolationTarget({ OMP_E2E_WORKSPACE: "ws" })).toBeNull();
		expect(
			readE2eIsolationTarget({
				OMP_E2E_MONITOR: " HEADLESS ",
				OMP_E2E_WORKSPACE: " ws-e2e ",
				OMP_HANDSFREE_E2E_TOKEN: " tok ",
			}),
		).toEqual({
			monitor: "HEADLESS",
			workspace: "ws-e2e",
			token: "tok",
		});
	});

	test("mergeE2eIsolationEnv stamps isolation keys and lets caller win", () => {
		const env = {
			OMP_E2E_MONITOR: "M",
			OMP_E2E_WORKSPACE: "W",
			OMP_HANDSFREE_E2E_TOKEN: "T",
		};
		expect(mergeE2eIsolationEnv(undefined, env)).toEqual({
			OMP_E2E_MONITOR: "M",
			OMP_E2E_WORKSPACE: "W",
			OMP_HUD_E2E_NO_PIN: "1",
			OMP_HANDSFREE_E2E_TOKEN: "T",
		});
		expect(mergeE2eIsolationEnv({ OMP_E2E_MONITOR: "caller", EXTRA: "1" }, env)).toEqual({
			OMP_E2E_MONITOR: "caller",
			OMP_E2E_WORKSPACE: "W",
			OMP_HUD_E2E_NO_PIN: "1",
			OMP_HANDSFREE_E2E_TOKEN: "T",
			EXTRA: "1",
		});
		expect(mergeE2eIsolationEnv({ FOO: "bar" }, {})).toEqual({ FOO: "bar" });
	});

	test("buildGatedHyprExecExpression wraps env and no_initial_focus", () => {
		const target = {
			monitor: "OMP-E2E-1",
			workspace: "omp-e2e-1",
			token: "TOKEN_1",
		};
		const expression = buildGatedHyprExecExpression("kitty --title demo", target);
		expect(expression.startsWith("hl.dsp.exec_cmd(")).toBe(true);
		expect(expression).toContain("OMP_HANDSFREE_E2E_TOKEN=TOKEN_1");
		expect(expression).toContain("OMP_E2E_MONITOR=OMP-E2E-1");
		expect(expression).toContain("OMP_E2E_WORKSPACE=omp-e2e-1");
		expect(expression).toContain('workspace = "name:omp-e2e-1"');
		expect(expression).toContain('monitor = "OMP-E2E-1"');
		expect(expression).toContain("no_initial_focus = true");
		expect(expression).toContain("kitty --title demo");
		expect(e2eIsolationChildEnv(target).OMP_HUD_E2E_NO_PIN).toBe("1");
	});
});

describe("HyprlandStageManager.execGated", () => {
	test("dispatches gated exec when isolation env is set", async () => {
		const previous = {
			OMP_E2E_MONITOR: process.env.OMP_E2E_MONITOR,
			OMP_E2E_WORKSPACE: process.env.OMP_E2E_WORKSPACE,
			OMP_HANDSFREE_E2E_TOKEN: process.env.OMP_HANDSFREE_E2E_TOKEN,
		};
		process.env.OMP_E2E_MONITOR = "HEADLESS";
		process.env.OMP_E2E_WORKSPACE = "ws-gate";
		process.env.OMP_HANDSFREE_E2E_TOKEN = "TOK";
		const dispatches: string[][] = [];
		const runner: HyprctlRunner = async args => {
			dispatches.push(args);
			return { stdout: "ok", stderr: "", exitCode: 0 } satisfies HyprctlResult;
		};
		try {
			const manager = new HyprlandStageManager(runner);
			const result = await manager.execGated("firefox https://example.com");
			expect(result.expression).toContain("firefox https://example.com");
			expect(dispatches).toEqual([["dispatch", result.expression]]);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("rejects when isolation env is missing", async () => {
		const previous = {
			OMP_E2E_MONITOR: process.env.OMP_E2E_MONITOR,
			OMP_E2E_WORKSPACE: process.env.OMP_E2E_WORKSPACE,
		};
		delete process.env.OMP_E2E_MONITOR;
		delete process.env.OMP_E2E_WORKSPACE;
		try {
			const manager = new HyprlandStageManager(async () => ({ stdout: "ok", stderr: "", exitCode: 0 }));
			await expect(manager.execGated("true")).rejects.toBeInstanceOf(ToolError);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
