import * as path from "node:path";
import { VERSION, getConfigRootDir } from "@oh-my-pi/pi-utils/dirs";
import type { AgentSession } from "../session/agent-session";
import { buildLoadedExtensionRecords } from "./resource-reload";
import { resolveCoreIdentity } from "./fingerprint";
import { getRuntimeAttestation, initRuntimeAttestation } from "./state";
import { registerRuntimeSession, RuntimeControlServer, type RuntimeControlMessage } from "./registry";

let controlServer: RuntimeControlServer | undefined;

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
	const attestation = initRuntimeAttestation({
		session_id: sessionId,
		cwd,
		core_version: VERSION,
		git_sha: core.git_sha,
		source_root: core.source_root,
		source_fingerprint: core.source_fingerprint,
		extensions,
		strategy: "startup",
		pid: process.pid,
	});

	const profileId = process.env.OMP_PROFILE || "default";
	const configRoot = getConfigRootDir();
	const socketPath = path.join(configRoot, "runtime", profileId, `${sessionId}.sock`);
	try {
		controlServer = new RuntimeControlServer(socketPath, async (message: RuntimeControlMessage) => {
			if (message.type === "ping") return { type: "pong", request_id: message.request_id };
			if (message.type === "status_request") {
				const snap = await attestation.snapshot();
				return {
					type: "status_reply",
					request_id: message.request_id,
					entry: {
						session_id: sessionId,
						pid: process.pid,
						socket_path: socketPath,
						started_at: snap.process.started_at,
						runtime_generation: snap.runtime.generation,
						profile_id: profileId,
						cwd,
						core_sha: snap.core.git_sha,
					},
					busy: attestation.isBusy || session.isStreaming ? "busy" : "idle",
					snapshot: snap,
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
		await registerRuntimeSession({
			session_id: sessionId,
			pid: process.pid,
			socket_path: socketPath,
			started_at: new Date().toISOString(),
			runtime_generation: attestation.generation,
			profile_id: profileId,
			cwd,
			core_sha: core.git_sha,
		}, configRoot);
	} catch {
		// Registry is best-effort; attestation remains valid without IPC.
	}
}

export async function shutdownRuntimeAttestationRegistry(): Promise<void> {
	await controlServer?.stop();
	controlServer = undefined;
}
