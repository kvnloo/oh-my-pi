import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	RuntimeControlServer,
	broadcastReloadAll,
	isPidAlive,
	listRuntimeRegistry,
	pruneDeadRegistryEntries,
	registerRuntimeSession,
	sendControlMessage,
	unregisterRuntimeSession,
	type RuntimeControlMessage,
	type RuntimeControlReply,
} from "@oh-my-pi/pi-coding-agent/live-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("multi-session registry reload-all (P5)", () => {
	it("idle reloads now, busy ACKs pending, stale is pruned unreachable", async () => {
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-reg-"));
		temporaryDirectories.push(configRoot);
		const profileId = "test-profile";
		const dir = path.join(configRoot, "runtime", profileId);
		await fs.mkdir(dir, { recursive: true });

		const idleSocket = path.join(dir, "idle.sock");
		const busySocket = path.join(dir, "busy.sock");

		let idleReloads = 0;
		const idleServer = new RuntimeControlServer(idleSocket, async (message: RuntimeControlMessage): Promise<RuntimeControlReply> => {
			if (message.type === "reload_request") {
				idleReloads += 1;
				return { type: "reload_ack", request_id: message.request_id, status: "reloading", generation: 2 };
			}
			return { type: "pong", request_id: message.request_id };
		});
		const busyServer = new RuntimeControlServer(busySocket, async (message: RuntimeControlMessage): Promise<RuntimeControlReply> => {
			if (message.type === "reload_request") {
				return { type: "reload_ack", request_id: message.request_id, status: "pending", generation: 1 };
			}
			return { type: "pong", request_id: message.request_id };
		});
		await idleServer.start();
		await busyServer.start();

		await registerRuntimeSession(
			{
				session_id: "sess-idle",
				pid: process.pid,
				socket_path: idleSocket,
				started_at: new Date().toISOString(),
				runtime_generation: 1,
				profile_id: profileId,
				cwd: configRoot,
			},
			configRoot,
		);
		await registerRuntimeSession(
			{
				session_id: "sess-busy",
				pid: process.pid,
				socket_path: busySocket,
				started_at: new Date().toISOString(),
				runtime_generation: 1,
				profile_id: profileId,
				cwd: configRoot,
			},
			configRoot,
		);
		await registerRuntimeSession(
			{
				session_id: "sess-stale",
				pid: 99999999,
				socket_path: path.join(dir, "missing.sock"),
				started_at: new Date().toISOString(),
				runtime_generation: 1,
				profile_id: profileId,
				cwd: configRoot,
			},
			configRoot,
		);

		expect(isPidAlive(99999999)).toBe(false);

		const result = await broadcastReloadAll({ profileId, configRoot });
		expect(result.requested).toContain("sess-idle");
		expect(result.requested).toContain("sess-busy");
		expect(result.acknowledged).toContain("sess-idle");
		expect(result.acknowledged).toContain("sess-busy");
		expect(result.completed).toContain("sess-idle");
		expect(result.pending).toContain("sess-busy");
		expect(result.unreachable).toContain("sess-stale");
		expect(idleReloads).toBe(1);

		// ACK is not completion for busy
		expect(result.completed).not.toContain("sess-busy");

		const remaining = await listRuntimeRegistry(profileId, configRoot);
		expect(remaining.some(e => e.session_id === "sess-stale")).toBe(false);

		await idleServer.stop();
		await busyServer.stop();
		await unregisterRuntimeSession("sess-idle", profileId, configRoot);
		await unregisterRuntimeSession("sess-busy", profileId, configRoot);
	});

	it("pruneDeadRegistryEntries removes dead PIDs", async () => {
		const configRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-runtime-prune-"));
		temporaryDirectories.push(configRoot);
		const profileId = "prune";
		await registerRuntimeSession(
			{
				session_id: "dead",
				pid: 1,
				socket_path: "/tmp/nope.sock",
				started_at: new Date().toISOString(),
				runtime_generation: 1,
				profile_id: profileId,
				cwd: configRoot,
			},
			configRoot,
		);
		// pid 1 may be alive on linux — use absurd pid
		await unregisterRuntimeSession("dead", profileId, configRoot);
		await registerRuntimeSession(
			{
				session_id: "dead",
				pid: 2147483646,
				socket_path: "/tmp/nope.sock",
				started_at: new Date().toISOString(),
				runtime_generation: 1,
				profile_id: profileId,
				cwd: configRoot,
			},
			configRoot,
		);
		const pruned = await pruneDeadRegistryEntries(profileId, configRoot);
		expect(pruned).toContain("dead");
	});
});
