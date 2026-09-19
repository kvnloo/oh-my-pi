/**
 * Permission apply/restore lifecycle for everyday /agy lane.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyPermissions,
	restorePermissions,
	researchPermissions,
	implementPermissions,
	withPermissions,
} from "../src/permissions.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "agy-perm-"));
const settingsPath = join(tmpRoot, "settings.json");

describe("permission profiles", () => {
	test("research denies writes; implement allows worktree writes only", () => {
		const repo = "/tmp/agy-parent-repo";
		const wt = "/tmp/agy-worktrees/impl-abc";
		const r = researchPermissions(repo);
		expect(r.allow.some((a) => a.includes(`read_file(${repo})`))).toBe(true);
		expect(r.deny.some((d) => d.includes(`write_file(${repo})`))).toBe(true);
		expect(r.deny.some((d) => d.includes("git push"))).toBe(true);

		const i = implementPermissions(wt, repo);
		expect(i.allow.some((a) => a.includes(`write_file(${wt})`))).toBe(true);
		expect(i.deny.some((d) => d.includes(`write_file(${repo})`))).toBe(true);
		expect(i.deny.some((d) => d.includes("git push"))).toBe(true);
	});
});

describe("withPermissions lifecycle", () => {
	test("restores after success", async () => {
		writeFileSync(settingsPath, JSON.stringify({ trustedWorkspaces: ["/keep"], marker: "orig" }, null, 2));
		const before = readFileSync(settingsPath, "utf8");
		const { scope } = await withPermissions(
			{
				profile: researchPermissions("/tmp/repo-a"),
				trusted_workspaces: ["/tmp/repo-a"],
				settings_path: settingsPath,
				tag: "success",
			},
			async (applied) => {
				const cur = JSON.parse(readFileSync(settingsPath, "utf8"));
				expect(cur.permissions.allow.length).toBeGreaterThan(0);
				expect(cur.marker).toBe("orig");
				expect(existsSync(applied.backup_path)).toBe(true);
				return "ok";
			},
		);
		expect(scope.applied).toBe(true);
		expect(scope.restored).toBe(true);
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
		expect(existsSync(`${settingsPath}.bak-agy-success`)).toBe(false);
	});

	test("restores after thrown error", async () => {
		writeFileSync(settingsPath, JSON.stringify({ marker: "pre-throw" }, null, 2));
		const before = readFileSync(settingsPath, "utf8");
		await expect(
			withPermissions(
				{
					profile: implementPermissions("/tmp/wt-x", "/tmp/repo-x"),
					settings_path: settingsPath,
					tag: "throw",
				},
				async () => {
					const cur = JSON.parse(readFileSync(settingsPath, "utf8"));
					expect(cur.permissions).toBeDefined();
					throw new Error("simulated-denial-path");
				},
			),
		).rejects.toThrow("simulated-denial-path");
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
		expect(existsSync(`${settingsPath}.bak-agy-throw`)).toBe(false);
	});

	test("restores after timeout-like rejection", async () => {
		writeFileSync(settingsPath, JSON.stringify({ marker: "pre-timeout" }, null, 2));
		const before = readFileSync(settingsPath, "utf8");
		await expect(
			withPermissions(
				{
					profile: researchPermissions("/tmp/repo-t"),
					settings_path: settingsPath,
					tag: "timeout",
				},
				async () => {
					await new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20));
					return null;
				},
			),
		).rejects.toThrow("timeout");
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
	});

	test("serializes concurrent scopes", async () => {
		mkdirSync(tmpRoot, { recursive: true });
		writeFileSync(settingsPath, JSON.stringify({ marker: "serial" }, null, 2));
		const seen: string[] = [];
		await Promise.all([
			withPermissions(
				{ profile: researchPermissions("/tmp/a"), settings_path: settingsPath, tag: "c1" },
				async () => {
					seen.push("c1-in");
					await new Promise((r) => setTimeout(r, 40));
					seen.push("c1-out");
				},
			),
			withPermissions(
				{ profile: researchPermissions("/tmp/b"), settings_path: settingsPath, tag: "c2" },
				async () => {
					seen.push("c2-in");
					await new Promise((r) => setTimeout(r, 10));
					seen.push("c2-out");
				},
			),
		]);
		const order = seen.join(",");
		expect(order === "c1-in,c1-out,c2-in,c2-out" || order === "c2-in,c2-out,c1-in,c1-out").toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).marker).toBe("serial");
	});
});

describe("apply/restore primitives", () => {
	test("applyPermissions writes allowlist and restorePermissions reverts", () => {
		writeFileSync(settingsPath, "{}\n");
		const applied = applyPermissions({
			profile: researchPermissions("/tmp/repo-prim"),
			settings_path: settingsPath,
			tag: "prim",
		});
		const mid = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(mid.permissions.allow.length).toBeGreaterThan(0);
		restorePermissions(applied.backup_path, settingsPath);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({});
	});
});
