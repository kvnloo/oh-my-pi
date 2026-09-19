import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { AgyDriver } from "../src/driver.ts";
import { parentCheckoutUntouched } from "../src/worktree.ts";

const MOCK = join(import.meta.dir, "../bin/mock-agy");

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-exec-"));
	execFileSync("git", ["init"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	writeFileSync(join(dir, "README.md"), "hi\n");
	mkdirSync(join(dir, "src"), { recursive: true });
	writeFileSync(join(dir, "src/example.ts"), "export const x=1;\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
	return dir;
}

const repo = initRepo();
const driver = new AgyDriver({ agy_bin: MOCK, prefer_warm: true, worktree_root: join(repo, ".agy-worktrees") });

afterAll(async () => {
	await driver.pool.drain();
});

describe("AgyDriver with mock-agy", () => {
	test("research warm turn returns receipt and avoids cursor", async () => {
		const r = await driver.research("investigate latency regressions", { cwd: repo });
		expect(r.role).toBe("research");
		expect(r.status).toBe("ok");
		expect(r.cursor_calls_avoided).toBe(1);
		expect(r.findings.length).toBeGreaterThan(0);
		expect(r.conversation_id).toBeTruthy();
	});

	test("second research reuses warm process (lower latency typically)", async () => {
		const a = await driver.research("research pool limits", { cwd: repo });
		const b = await driver.research("research timeout cascade", { cwd: repo });
		expect(a.conversation_id).toBe(b.conversation_id);
		expect(b.duration_ms).toBeLessThan(2000);
	});

	test("implement uses isolated worktree; parent untouched", async () => {
		const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const r = await driver.implement("implement a tiny comment-only clarification", { repo });
		expect(r.role).toBe("implementation");
		expect(r.status).toBe("ok");
		expect(r.worktree.includes(".agy-worktrees")).toBe(true);
		expect(r.parent_checkout_untouched).toBe(true);
		expect(parentCheckoutUntouched(repo, base)).toBe(true);
		expect(r.cursor_calls_avoided).toBe(1);
	});

	test("cold print path works", async () => {
		const cold = new AgyDriver({ agy_bin: MOCK, prefer_warm: false });
		const r = await cold.research("research cold start", { cwd: repo, warm: false });
		expect(r.status).toBe("ok");
		await cold.pool.drain();
	});
});
