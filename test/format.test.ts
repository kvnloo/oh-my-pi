import { describe, expect, it } from "bun:test";
import {
	commitMatches,
	EXPECTED_EXTENSIONS,
} from "../src/manifest.ts";
import {
	formatRuntimeStatus,
	formatRuntimeStatusAll,
	resolvePresence,
	resolveExtensionGitSha,
	summarizeExpected,
} from "../src/format.ts";
import type { RuntimeSnapshot } from "@oh-my-pi/pi-coding-agent/live-runtime";

describe("expected extension manifest", () => {
	it("pins agy-executor to P0.6 SHA a1686ce", () => {
		const agy = EXPECTED_EXTENSIONS.find(e => e.id === "agy-executor");
		expect(agy?.expectedCommit?.startsWith("a1686ce")).toBe(true);
	});

	it("commitMatches accepts prefix equality", () => {
		expect(commitMatches("a1686ceed36731da83346fcd5c7d3418406d8cf6", "a1686ce")).toBe(true);
		expect(commitMatches("deadbeef", "a1686ce")).toBe(false);
		expect(commitMatches(undefined, "a1686ce")).toBe(false);
		expect(commitMatches("abc", undefined)).toBe(true);
	});
});

describe("z0-live-runtime status formatting", () => {
	it("formats status with git sha column and marks ACTIVE only from snapshot proof", () => {
		const snapshot: RuntimeSnapshot = {
			schema: "omp.runtime.v1",
			process: { pid: 1, started_at: "2026-01-01T00:00:00.000Z" },
			session: { session_id: "abc", cwd: "/tmp" },
			core: { version: "18.2.5", git_sha: "a699c2b", source_fingerprint: "fp" },
			runtime: { generation: 14, activated_at: "2026-01-01T00:00:00.000Z", strategy: "startup" },
			extensions: [
				{
					id: "z0-live-runtime",
					path: "/home/kvn/tmp/omp-ext-z0-live-runtime/src/extension.ts",
					fingerprint: "aaa",
					loaded_at: "2026-01-01T00:00:00.000Z",
					disk_fingerprint: "aaa",
					stale: false,
				},
			],
		};
		const text = formatRuntimeStatus(snapshot);
		expect(text).toContain("OMP Runtime");
		expect(text).toContain("generation       14");
		expect(text).toContain("ACTIVE");
		expect(text).toContain("MISSING"); // cognitive-state / agy not in snapshot
		expect(resolvePresence(undefined)).toBe("MISSING");
		expect(resolvePresence(snapshot.extensions[0])).toBe("ACTIVE");
		expect(resolvePresence({ ...snapshot.extensions[0]!, stale: true, disk_fingerprint: "bbb" })).toBe("STALE");
	});

	it("marks agy STALE when loaded git sha mismatches expectedCommit", () => {
		const ext = {
			id: "agy-executor",
			path: "/home/kvn/tmp/omp-ext-agy-executor/index.ts",
			fingerprint: "abc",
			loaded_at: "2026-01-01T00:00:00.000Z",
			disk_fingerprint: "abc",
			stale: false,
		};
		const expected = EXPECTED_EXTENSIONS.find(e => e.id === "agy-executor");
		expect(resolvePresence(ext, expected, "0ab322140d1a9170c8dcf917bdb4681d04c4e719")).toBe("STALE");
		expect(resolvePresence(ext, expected, "a1686ceed36731da83346fcd5c7d3418406d8cf6")).toBe("ACTIVE");
	});

	it("status --all table includes AGY_SHA", () => {
		const text = formatRuntimeStatusAll([
			{
				session_id: "01a0b86d-4133-7000-ac1e-d4c1ffe1c947",
				pid: 1,
				core: "1a62bc6934abcdef",
				generation: 2,
				cognitive: "ACTIVE",
				agy: "ACTIVE",
				agy_sha: "a1686ceed36731da83346fcd5c7d3418406d8cf6",
				state: "idle",
			},
		]);
		expect(text).toContain("AGY_SHA");
		expect(text).toContain("a1686ce");
		expect(text).toContain("ACTIVE");
	});

	it("resolves real agy package git sha from disk", () => {
		const sha = resolveExtensionGitSha("/home/kvn/tmp/omp-ext-agy-executor/index.ts");
		expect(sha?.startsWith("a1686ce")).toBe(true);
	});

	it("summarizeExpected reports agy sha for loaded package", () => {
		const snapshot: RuntimeSnapshot = {
			schema: "omp.runtime.v1",
			process: { pid: 1, started_at: "2026-01-01T00:00:00.000Z" },
			session: { session_id: "abc", cwd: "/tmp" },
			core: { version: "18.2.5", git_sha: "db0b37c", source_fingerprint: "fp" },
			runtime: { generation: 1, activated_at: "2026-01-01T00:00:00.000Z", strategy: "startup" },
			extensions: [
				{
					id: "agy-executor",
					path: "/home/kvn/tmp/omp-ext-agy-executor/index.ts",
					fingerprint: "fp-agy",
					loaded_at: "2026-01-01T00:00:00.000Z",
					disk_fingerprint: "fp-agy",
					stale: false,
				},
			],
		};
		const s = summarizeExpected(snapshot);
		expect(s.agy).toBe("ACTIVE");
		expect(s.agy_sha.startsWith("a1686ce")).toBe(true);
		expect(s.cognitive).toBe("MISSING");
	});
});
