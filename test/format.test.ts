import { describe, expect, it } from "bun:test";
import { formatRuntimeStatus, resolvePresence } from "../src/format.ts";
import type { RuntimeSnapshot } from "@oh-my-pi/pi-coding-agent/live-runtime";

describe("z0-live-runtime status formatting", () => {
	it("formats status and marks ACTIVE only from snapshot proof", () => {
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
});
