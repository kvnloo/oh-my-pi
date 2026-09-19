import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	fingerprintExtensionSource,
	getRuntimeAttestation,
	initRuntimeAttestation,
	resetRuntimeAttestation,
	validateExtensionCandidates,
} from "@oh-my-pi/pi-coding-agent/live-runtime";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

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

describe("single-session runtime reload (P3)", () => {
	it("P3.1 reload activates v2 and increments generation once; transcript unchanged", async () => {
		const directory = await tempDir("omp-runtime-p31-");
		const extensionPath = path.join(directory, "sentinel.ts");
		await Bun.write(
			extensionPath,
			`export default function (pi) {\n  pi.setLabel("sentinel-v1");\n  pi.registerCommand("sentinel", { description: "s", handler: async (_a, ctx) => { ctx.ui.notify("v1", "info"); } });\n}\n`,
		);
		const v1 = await fingerprintExtensionSource(extensionPath);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
		const sessionManager = SessionManager.inMemory(directory);
		const preloaded = await loadExtensions([extensionPath], directory, new EventBus());
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			sessionManager,
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			initRuntimeAttestation({
				session_id: session.sessionManager.getSessionId(),
				cwd: directory,
				core_version: "test",
				source_fingerprint: "core",
				extensions: [
					{ id: "sentinel", path: extensionPath, fingerprint: v1, loaded_at: new Date().toISOString() },
				],
			});

			const beforeEntries = session.sessionManager.getBranch().length;
			const beforeSnap = await getRuntimeAttestation()!.snapshot();
			expect(beforeSnap.runtime.generation).toBe(1);
			expect(beforeSnap.extensions[0]?.stale).toBe(false);

			await Bun.write(
				extensionPath,
				`export default function (pi) {\n  pi.setLabel("sentinel-v2");\n  pi.registerCommand("sentinel", { description: "s", handler: async (_a, ctx) => { ctx.ui.notify("v2", "info"); } });\n}\n`,
			);
			const staleSnap = await getRuntimeAttestation()!.snapshot();
			expect(staleSnap.extensions[0]?.stale).toBe(true);
			expect(staleSnap.extensions[0]?.fingerprint).toBe(v1);

			const result = await session.reloadRuntime({ reason: "test", agentDir: directory });
			expect(result.status).toBe("reloaded");
			expect(result.generation).toBe(2);

			const afterSnap = await getRuntimeAttestation()!.snapshot();
			expect(afterSnap.runtime.generation).toBe(2);
			expect(afterSnap.extensions[0]?.stale).toBe(false);
			expect(afterSnap.extensions[0]?.fingerprint).not.toBe(v1);
			expect(session.sessionManager.getBranch().length).toBe(beforeEntries);

			expect(getRuntimeAttestation()!.generation).toBe(2);
			expect(session.extensionPaths?.some(p => p.includes("sentinel"))).toBe(true);
		} finally {
			await session.dispose();
			authStorage.close();
			removeSyncWithRetries(directory);
		}
	});

	it("P3.2 failed reload keeps generation and leaves session usable", async () => {
		const directory = await tempDir("omp-runtime-p32-");
		const extensionPath = path.join(directory, "sentinel.ts");
		await Bun.write(
			extensionPath,
			`export default function (pi) {\n  pi.setLabel("ok");\n}\n`,
		);
		const v1 = await fingerprintExtensionSource(extensionPath);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
		const sessionManager = SessionManager.inMemory(directory);
		const preloaded = await loadExtensions([extensionPath], directory, new EventBus());
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			sessionManager,
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			initRuntimeAttestation({
				session_id: session.sessionManager.getSessionId(),
				cwd: directory,
				core_version: "test",
				source_fingerprint: "core",
				extensions: [
					{ id: "sentinel", path: extensionPath, fingerprint: v1, loaded_at: new Date().toISOString() },
				],
			});
			const beforeEntries = session.sessionManager.getBranch().length;

			await Bun.write(extensionPath, `this is not valid typescript (((\n`);
			const result = await session.reloadRuntime({ agentDir: directory });
			expect(result.status).toBe("failed");
			expect(result.generation).toBe(1);
			expect(getRuntimeAttestation()!.generation).toBe(1);
			const snap = await getRuntimeAttestation()!.snapshot();
			expect(snap.last_activation?.status).toBe("failed");
			expect(session.sessionManager.getBranch().length).toBe(beforeEntries);
			expect(session.extensionPaths?.length).toBeGreaterThan(0);
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("P3.3 busy session returns RELOAD_PENDING without interrupting", async () => {
		const directory = await tempDir("omp-runtime-p33-");
		const extensionPath = path.join(directory, "sentinel.ts");
		await Bun.write(extensionPath, `export default function (pi) { pi.setLabel("x"); }\n`);
		const v1 = await fingerprintExtensionSource(extensionPath);
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(directory, "models.yml"));
		const sessionManager = SessionManager.inMemory(directory);
		const preloaded = await loadExtensions([extensionPath], directory, new EventBus());
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			sessionManager,
			modelRegistry,
			settings: Settings.isolated(),
			preloadedExtensions: preloaded,
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			initRuntimeAttestation({
				session_id: session.sessionManager.getSessionId(),
				cwd: directory,
				core_version: "test",
				source_fingerprint: "core",
				extensions: [
					{ id: "sentinel", path: extensionPath, fingerprint: v1, loaded_at: new Date().toISOString() },
				],
			});
			// Simulate busy turn via attestation busy flag + streaming check path:
			// force queued follow-up by setting attestation busy and stubbing isStreaming via pending marker path.
			getRuntimeAttestation()!.setBusy(true);
			// reloadRuntime checks isStreaming || queuedMessageCount — with idle session it would reload.
			// Use validate-only path by temporarily marking pending via busy simulation on attestation,
			// and call mark through reload when we inject a fake streaming state.
			const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(session), "isStreaming");
			Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
			const result = await session.reloadRuntime({ agentDir: directory });
			expect(result.status).toBe("pending");
			expect(result.generation).toBe(1);
			expect(getRuntimeAttestation()!.reloadPending).toBe(true);
			if (original) Object.defineProperty(Object.getPrototypeOf(session), "isStreaming", original);
			else Reflect.deleteProperty(session, "isStreaming");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	});

	it("validateExtensionCandidates rejects syntax failures before activation", async () => {
		const directory = await tempDir("omp-runtime-validate-");
		const extensionPath = path.join(directory, "bad.ts");
		await Bun.write(extensionPath, "export default function(pi) {");
		const result = await validateExtensionCandidates([extensionPath], directory);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.failure_reason.length).toBeGreaterThan(0);
	});
});
