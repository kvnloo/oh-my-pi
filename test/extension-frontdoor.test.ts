import { describe, expect, test, afterAll } from "bun:test";
import { join } from "node:path";
import agyExecutorExtension, { createState } from "../src/extension.ts";

const MOCK = join(import.meta.dir, "../bin/mock-agy");

describe("front-door input handled", () => {
	test("agy route returns handled:true and never needs provider", async () => {
		process.env.AGY_BIN = MOCK;
		const handlers = new Map<string, Function[]>();
		const entries: Array<{ type: string; data: unknown }> = [];
		const messages: unknown[] = [];
		const pi = {
			registerCommand() {},
			on(event: string, handler: Function) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			sendMessage(msg: unknown) {
				messages.push(msg);
			},
			appendEntry(type: string, data: unknown) {
				entries.push({ type, data });
			},
		};
		// Monkeypatch: extension uses ctx from handler, not pi.sendMessage directly
		agyExecutorExtension(pi as never);
		const state = (pi as any)._agyExecutor as ReturnType<typeof createState>;
		state.driver = createState().driver;
		// recreate driver with mock
		const { AgyDriver } = await import("../src/driver.ts");
		state.driver = new AgyDriver({ agy_bin: MOCK, prefer_warm: true });

		const inputHandlers = handlers.get("input") ?? [];
		expect(inputHandlers.length).toBe(1);
		const ctx = {
			sendMessage: (m: unknown) => messages.push(m),
			appendEntry: (t: string, d: unknown) => entries.push({ type: t, data: d }),
			ui: { notify() {} },
		};
		const result = await inputHandlers[0]!({ type: "input", text: "agy:r why does the hang happen?", source: "interactive" }, ctx);
		expect(result).toEqual({ handled: true });
		expect(state.cursor_calls_avoided).toBe(1);
		expect(state.omp_provider_requests_intercepted).toBe(1);
		expect(entries.some((e) => e.type === "z0.agy.research_receipt")).toBe(true);
		expect(messages.length).toBeGreaterThan(0);

		// Ordinary prompt is NOT handled (Cursor path would continue)
		const r2 = await inputHandlers[0]!({ type: "input", text: "please explain this file", source: "interactive" }, ctx);
		expect(r2).toBeUndefined();

		await state.driver.pool.drain();
	});

	test("implement prefix also handled", async () => {
		process.env.AGY_BIN = MOCK;
		const handlers = new Map<string, Function[]>();
		const pi = {
			registerCommand() {},
			on(e: string, h: Function) {
				(handlers.get(e) ?? handlers.set(e, []).get(e)!).push(h);
			},
		};
		agyExecutorExtension(pi as never);
		const state = (pi as any)._agyExecutor;
		const { AgyDriver } = await import("../src/driver.ts");
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { execFileSync } = await import("node:child_process");
		const dir = mkdtempSync(join(tmpdir(), "agy-ext-"));
		execFileSync("git", ["init"], { cwd: dir });
		execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
		execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
		writeFileSync(join(dir, "a.txt"), "a\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["commit", "-m", "i"], { cwd: dir });
		state.driver = new AgyDriver({ agy_bin: MOCK, prefer_warm: true, worktree_root: join(dir, ".agy-worktrees") });
		const cwd = process.cwd();
		process.chdir(dir);
		try {
			const ctx = { sendMessage() {}, appendEntry() {}, ui: { notify() {} } };
			const result = await handlers.get("input")![0]!({ type: "input", text: "/agy implement add a comment", source: "interactive" }, ctx);
			expect(result).toEqual({ handled: true });
			expect(state.last_implement?.parent_checkout_untouched).toBe(true);
		} finally {
			process.chdir(cwd);
			await state.driver.pool.drain();
		}
	});
});
