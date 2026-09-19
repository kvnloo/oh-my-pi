import * as path from "node:path";
import { VERSION, getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import type { AgentSession } from "../session/agent-session";
import { buildLoadedExtensionRecords } from "./resource-reload";
import { resolveCoreIdentity } from "./fingerprint";
import { getRuntimeAttestation, initRuntimeAttestation } from "./state";
import {
	registerRuntimeSession,
	unregisterRuntimeSession,
	RuntimeControlServer,
	type RuntimeControlMessage,
	type RuntimeRegistryEntry,
} from "./registry";

let controlServer: RuntimeControlServer | undefined;
let registeredSessionId: string | undefined;
let registeredProfileId: string | undefined;
let registeredConfigRoot: string | undefined;

function parseHandoffGeneration(): number {
	const raw = Number(process.env.OMP_LIVE_RUNTIME_GENERATION ?? "1");
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

async function materializeSessionPath(session: AgentSession): Promise<string | undefined> {
	await session.sessionManager.ensureOnDisk();
	return session.sessionManager.getSessionFile();
}

function buildRegistryEntry(input: {
	sessionId: string;
	socketPath: string;
	startedAt: string;
	generation: number;
	profileId: string;
	cwd: string;
	coreSha?: string;
	sessionPath?: string;
}): RuntimeRegistryEntry {
	return {
		session_id: input.sessionId,
		pid: process.pid,
		socket_path: input.socketPath,
		started_at: input.startedAt,
		runtime_generation: input.generation,
		profile_id: input.profileId,
		cwd: input.cwd,
		core_sha: input.coreSha,
		session_path: input.sessionPath,
	};
}

/** Ensure this process has a RuntimeAttestationState. Never clobber an existing generation. */
export async function ensureRuntimeAttestation(session: AgentSession): Promise<void> {
	const sessionId = session.sessionManager.getSessionId();
	const existing = getRuntimeAttestation();
	if (existing) {
		existing.setSession(sessionId, session.sessionManager.getCwd());
		return;
	}

	const cwd = session.sessionManager.getCwd();
	const core = await resolveCoreIdentity({ version: VERSION });
	const raced = getRuntimeAttestation();
	if (raced) {
		raced.setSession(sessionId, cwd);
		return;
	}

	const paths = [...(session.extensionPaths ?? [])].filter(p => !p.startsWith("<inline"));
	const extensions = await buildLoadedExtensionRecords(paths);
	if (getRuntimeAttestation()) {
		getRuntimeAttestation()!.setSession(sessionId, cwd);
		return;
	}

	const generation = parseHandoffGeneration();
	const attestation = initRuntimeAttestation({
		session_id: sessionId,
		cwd,
		core_version: VERSION,
		git_sha: core.git_sha,
		source_root: core.source_root,
		source_fingerprint: core.source_fingerprint,
		extensions,
		strategy: generation > 1 ? "warm-reboot" : "startup",
		pid: process.pid,
		generation,
	});

	const profileId = process.env.OMP_PROFILE || "default";
	const configRoot = getConfigRootDir();
	const socketPath = path.join(configRoot, "runtime", profileId, `${sessionId}.${process.pid}.sock`);
	const sessionPath = await materializeSessionPath(session).catch(() => undefined);
	const startedAt = new Date().toISOString();

	try {
		controlServer = new RuntimeControlServer(socketPath, async (message: RuntimeControlMessage) => {
			if (message.type === "ping") return { type: "pong", request_id: message.request_id };
			if (message.type === "status_request") {
				const snap = await attestation.snapshot();
				const liveSessionPath = session.sessionManager.getSessionFile() ?? sessionPath;
				return {
					type: "status_reply",
					request_id: message.request_id,
					entry: buildRegistryEntry({
						sessionId,
						socketPath,
						startedAt: snap.process.started_at,
						generation: snap.runtime.generation,
						profileId,
						cwd,
						coreSha: snap.core.git_sha,
						sessionPath: liveSessionPath,
					}),
					busy: attestation.isBusy || session.isStreaming ? "busy" : "idle",
					snapshot: snap,
				};
			}
			if (message.type === "prepare_handoff") {
				const flushed = await materializeSessionPath(session);
				const entry = buildRegistryEntry({
					sessionId,
					socketPath,
					startedAt,
					generation: attestation.generation,
					profileId,
					cwd,
					coreSha: core.git_sha,
					sessionPath: flushed,
				});
				await registerRuntimeSession(entry, configRoot);
				return {
					type: "prepare_handoff_reply",
					request_id: message.request_id,
					session_id: sessionId,
					session_path: flushed,
					cwd,
				};
			}
			if (message.type === "reload_request") {
				const result = await session.reloadRuntime({ reason: message.reason });
				if (result.status === "pending") {
					return { type: "reload_ack", request_id: message.request_id, status: "pending", generation: result.generation };
				}
				if (result.status === "failed") {
					return {
						type: "reload_ack",
						request_id: message.request_id,
						status: "failed",
						generation: result.generation,
						failure_reason: result.failure_reason,
					};
				}
				return { type: "reload_ack", request_id: message.request_id, status: "reloading", generation: result.generation };
			}
			return { type: "pong", request_id: (message as { request_id: string }).request_id };
		});
		await controlServer.start();
		await registerRuntimeSession(
			buildRegistryEntry({
				sessionId,
				socketPath,
				startedAt,
				generation: attestation.generation,
				profileId,
				cwd,
				coreSha: core.git_sha,
				sessionPath,
			}),
			configRoot,
		);
		registeredSessionId = sessionId;
		registeredProfileId = profileId;
		registeredConfigRoot = configRoot;
	} catch {
		// Registry is best-effort; attestation remains valid without IPC.
		// Still try to publish a registry row so warm-reboot READY can observe pid.
		try {
			await registerRuntimeSession(
				buildRegistryEntry({
					sessionId,
					socketPath,
					startedAt,
					generation: attestation.generation,
					profileId,
					cwd,
					coreSha: core.git_sha,
					sessionPath,
				}),
				configRoot,
			);
			registeredSessionId = sessionId;
			registeredProfileId = profileId;
			registeredConfigRoot = configRoot;
		} catch {
			/* ignore */
		}
	}
}

export async function shutdownRuntimeAttestationRegistry(): Promise<void> {
	await controlServer?.stop();
	controlServer = undefined;
	if (registeredSessionId) {
		await unregisterRuntimeSession(
			registeredSessionId,
			registeredProfileId,
			registeredConfigRoot,
			process.pid,
		).catch(() => undefined);
	}
	registeredSessionId = undefined;
	registeredProfileId = undefined;
	registeredConfigRoot = undefined;
}
