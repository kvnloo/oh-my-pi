import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	RUNTIME_SNAPSHOT_SCHEMA,
	RuntimeAttestationState,
	buildRuntimeSnapshot,
	fingerprintBytes,
	fingerprintExtensionSource,
	resetRuntimeAttestation,
} from "@oh-my-pi/pi-coding-agent/live-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	resetRuntimeAttestation();
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

async function tempDir(prefix: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

describe("RuntimeSnapshot schema (P0.1)", () => {
	it("emits stable schema id omp.runtime.v1", async () => {
		const snapshot = await buildRuntimeSnapshot({
			pid: 42,
			started_at: "2026-01-01T00:00:00.000Z",
			session_id: "sess-1",
			cwd: "/tmp/work",
			core_version: "18.2.5",
			source_fingerprint: "corefp",
			generation: 1,
			activated_at: "2026-01-01T00:00:00.000Z",
			strategy: "startup",
			extensions: [],
		});
		expect(snapshot.schema).toBe(RUNTIME_SNAPSHOT_SCHEMA);
		expect(snapshot.schema).toBe("omp.runtime.v1");
	});

	it("requires generation >= 1", async () => {
		await expect(
			buildRuntimeSnapshot({
				pid: 1,
				started_at: "2026-01-01T00:00:00.000Z",
				session_id: "s",
				cwd: "/tmp",
				core_version: "1",
				source_fingerprint: "x",
				generation: 0,
				activated_at: "2026-01-01T00:00:00.000Z",
				strategy: "startup",
				extensions: [],
			}),
		).rejects.toThrow(/generation must be >= 1/);
	});

	it("de-duplicates loaded extension paths", async () => {
		const directory = await tempDir("omp-runtime-dedupe-");
		const extensionPath = path.join(directory, "ext.ts");
		await Bun.write(extensionPath, "export default function() {}");
		const fp = await fingerprintExtensionSource(extensionPath);
		const snapshot = await buildRuntimeSnapshot({
			pid: 1,
			started_at: "2026-01-01T00:00:00.000Z",
			session_id: "s",
			cwd: directory,
			core_version: "1",
			source_fingerprint: "x",
			generation: 1,
			activated_at: "2026-01-01T00:00:00.000Z",
			strategy: "startup",
			extensions: [
				{ id: "ext", path: extensionPath, fingerprint: fp, loaded_at: "2026-01-01T00:00:00.000Z" },
				{ id: "ext-dup", path: extensionPath, fingerprint: fp, loaded_at: "2026-01-01T00:00:01.000Z" },
			],
		});
		expect(snapshot.extensions).toHaveLength(1);
		expect(snapshot.extensions[0]?.id).toBe("ext");
	});

	it("does not silently replace active fingerprint with disk fingerprint", async () => {
		const directory = await tempDir("omp-runtime-active-disk-");
		const extensionPath = path.join(directory, "ext.ts");
		await Bun.write(extensionPath, "export default function v1() {}");
		const active = await fingerprintExtensionSource(extensionPath);
		await Bun.write(extensionPath, "export default function v2() {}");
		const disk = await fingerprintExtensionSource(extensionPath);
		expect(disk).not.toBe(active);

		const snapshot = await buildRuntimeSnapshot({
			pid: 1,
			started_at: "2026-01-01T00:00:00.000Z",
			session_id: "s",
			cwd: directory,
			core_version: "1",
			source_fingerprint: "x",
			generation: 1,
			activated_at: "2026-01-01T00:00:00.000Z",
			strategy: "startup",
			extensions: [{ id: "ext", path: extensionPath, fingerprint: active, loaded_at: "2026-01-01T00:00:00.000Z" }],
		});

		expect(snapshot.extensions[0]?.fingerprint).toBe(active);
		expect(snapshot.extensions[0]?.disk_fingerprint).toBe(disk);
		expect(snapshot.extensions[0]?.fingerprint).not.toBe(snapshot.extensions[0]?.disk_fingerprint);
		expect(snapshot.extensions[0]?.stale).toBe(true);
	});

	it("marks stale=true when disk source changes after activation", async () => {
		const directory = await tempDir("omp-runtime-stale-");
		const extensionPath = path.join(directory, "ext.ts");
		await Bun.write(extensionPath, "v1");
		const active = fingerprintBytes("v1-active-marker");
		const snapshot = await buildRuntimeSnapshot({
			pid: 1,
			started_at: "2026-01-01T00:00:00.000Z",
			session_id: "s",
			cwd: directory,
			core_version: "1",
			source_fingerprint: "x",
			generation: 2,
			activated_at: "2026-01-01T00:00:00.000Z",
			strategy: "runtime-reload",
			extensions: [{ id: "ext", path: extensionPath, fingerprint: active, loaded_at: "2026-01-01T00:00:00.000Z" }],
		});
		expect(snapshot.extensions[0]?.stale).toBe(true);
	});

	it("reading snapshot has no mutation side effect on active fingerprints", async () => {
		const directory = await tempDir("omp-runtime-readonly-");
		const extensionPath = path.join(directory, "ext.ts");
		await Bun.write(extensionPath, "export default function v1() {}");
		const active = await fingerprintExtensionSource(extensionPath);
		const state = new RuntimeAttestationState({
			session_id: "s",
			cwd: directory,
			core_version: "1",
			source_fingerprint: "core",
			extensions: [{ id: "ext", path: extensionPath, fingerprint: active, loaded_at: "2026-01-01T00:00:00.000Z" }],
		});

		await Bun.write(extensionPath, "export default function v2() {}");
		const first = await state.snapshot();
		const second = await state.snapshot();

		expect(first.extensions[0]?.fingerprint).toBe(active);
		expect(second.extensions[0]?.fingerprint).toBe(active);
		expect(first.extensions[0]?.stale).toBe(true);
		expect(second.extensions[0]?.stale).toBe(true);
		expect(first.runtime.generation).toBe(1);
		expect(second.runtime.generation).toBe(1);
	});
});

describe("Active-vs-disk proof (P0.2)", () => {
	it("reports active=v1 disk=v2 stale=true without reload", async () => {
		const directory = await tempDir("omp-runtime-p02-");
		const extensionPath = path.join(directory, "fixture-ext.ts");
		await Bun.write(
			extensionPath,
			`export default function fixtureV1(pi) { pi.setLabel("v1"); }\n`,
		);
		const v1 = await fingerprintExtensionSource(extensionPath);
		const state = new RuntimeAttestationState({
			session_id: "proof-session",
			cwd: directory,
			core_version: "18.2.5",
			source_fingerprint: "core-fp",
			extensions: [
				{
					id: "fixture-ext",
					path: extensionPath,
					fingerprint: v1,
					loaded_at: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		const before = await state.snapshot();
		expect(before.extensions[0]?.fingerprint).toBe(v1);
		expect(before.extensions[0]?.disk_fingerprint).toBe(v1);
		expect(before.extensions[0]?.stale).toBe(false);

		await Bun.write(
			extensionPath,
			`export default function fixtureV2(pi) { pi.setLabel("v2"); }\n`,
		);
		const v2 = await fingerprintExtensionSource(extensionPath);
		expect(v2).not.toBe(v1);

		const after = await state.snapshot();
		expect(after.extensions[0]?.fingerprint).toBe(v1);
		expect(after.extensions[0]?.disk_fingerprint).toBe(v2);
		expect(after.extensions[0]?.stale).toBe(true);
	});
});

describe("Runtime generation (P0.3)", () => {
	it("starts at generation 1 and increments only on successful activation", async () => {
		const state = new RuntimeAttestationState({
			session_id: "gen",
			cwd: "/tmp",
			core_version: "1",
			source_fingerprint: "x",
		});
		expect(state.generation).toBe(1);
		const startup = await state.snapshot();
		expect(startup.runtime.generation).toBe(1);

		const started = "2026-01-01T00:00:10.000Z";
		state.rejectActivation({
			strategy: "runtime-reload",
			started_at: started,
			failure_reason: "candidate import failed",
		});
		expect(state.generation).toBe(1);
		const failed = await state.snapshot();
		expect(failed.runtime.generation).toBe(1);
		expect(failed.last_activation?.status).toBe("failed");
		expect(failed.last_activation?.to_generation).toBe(1);

		const next = state.commitActivation({
			strategy: "runtime-reload",
			started_at: "2026-01-01T00:00:20.000Z",
			completed_at: "2026-01-01T00:00:21.000Z",
			changed_files: ["ext.ts"],
		});
		expect(next).toBe(2);
		expect(state.generation).toBe(2);
		const ok = await state.snapshot();
		expect(ok.runtime.generation).toBe(2);
		expect(ok.runtime.strategy).toBe("runtime-reload");
		expect(ok.last_activation?.from_generation).toBe(1);
		expect(ok.last_activation?.to_generation).toBe(2);
		expect(ok.last_activation?.status).toBe("success");
	});

	it("does not increment generation before successful activation", async () => {
		const state = new RuntimeAttestationState({
			session_id: "gen2",
			cwd: "/tmp",
			core_version: "1",
			source_fingerprint: "x",
		});
		state.markPendingActivation({
			from_generation: 1,
			to_generation: 2,
			strategy: "runtime-reload",
			changed_files: [],
			started_at: "2026-01-01T00:00:00.000Z",
		});
		expect(state.generation).toBe(1);
		expect(state.reloadPending).toBe(true);
		const snap = await state.snapshot();
		expect(snap.runtime.generation).toBe(1);
	});
});

describe("package-aware extension fingerprints", () => {
	it("does not collide on identical index.ts barrels with different implementations", async () => {
		const root = await tempDir("omp-runtime-pkg-fp-");
		async function makePkg(name: string, body: string): Promise<string> {
			const dir = path.join(root, name);
			await fs.mkdir(path.join(dir, "src"), { recursive: true });
			await Bun.write(
				path.join(dir, "package.json"),
				JSON.stringify({ name, type: "module", omp: { extensions: ["./index.ts"] } }, null, 2) + "\n",
			);
			await Bun.write(path.join(dir, "index.ts"), 'export { default } from "./src/extension.ts";\n');
			await Bun.write(path.join(dir, "src/extension.ts"), body);
			return path.join(dir, "index.ts");
		}
		const a = await makePkg("agy-like", "export default function agy() { return \"a\"; }\n");
		const b = await makePkg("cognitive-like", "export default function cognitive() { return \"b\"; }\n");
		const fa = await fingerprintExtensionSource(a);
		const fb = await fingerprintExtensionSource(b);
		expect(fa).not.toBe(fb);
		// Changing only the implementation changes the fingerprint.
		await Bun.write(path.join(root, "agy-like/src/extension.ts"), "export default function agy() { return \"a2\"; }\n");
		const fa2 = await fingerprintExtensionSource(a);
		expect(fa2).not.toBe(fa);
	});
});
