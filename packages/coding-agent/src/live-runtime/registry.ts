import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { getConfigRootDir, isEnoent, logger } from "@oh-my-pi/pi-utils";

export const REGISTRY_SCHEMA = "omp.runtime.registry.v1" as const;

export type SessionBusyState = "idle" | "busy";

export interface RuntimeRegistryEntry {
	session_id: string;
	pid: number;
	socket_path: string;
	started_at: string;
	runtime_generation: number;
	profile_id: string;
	cwd: string;
	core_sha?: string;
	/** Materialized transcript path for warm-reboot --resume. */
	session_path?: string;
}

export type RuntimeControlMessage =
	| { type: "reload_request"; request_id: string; reason?: string }
	| { type: "status_request"; request_id: string }
	| { type: "ping"; request_id: string }
	| { type: "prepare_handoff"; request_id: string };

export type RuntimeControlReply =
	| {
			type: "reload_ack";
			request_id: string;
			status: "reloading" | "pending" | "failed";
			generation?: number;
			failure_reason?: string;
	  }
	| {
			type: "status_reply";
			request_id: string;
			entry: RuntimeRegistryEntry;
			busy: SessionBusyState;
			snapshot?: unknown;
	  }
	| {
			type: "prepare_handoff_reply";
			request_id: string;
			session_id: string;
			session_path?: string;
			cwd: string;
	  }
	| { type: "pong"; request_id: string };

export interface ReloadAllResult {
	requested: string[];
	acknowledged: string[];
	pending: string[];
	completed: string[];
	failed: Array<{ session_id: string; reason: string }>;
	unreachable: string[];
}

export function runtimeRegistryDir(profileId = "default", configRoot = getConfigRootDir()): string {
	return path.join(configRoot, "runtime", profileId);
}

export function runtimeRegistryEntryPath(
	sessionId: string,
	profileId = "default",
	configRoot = getConfigRootDir(),
): string {
	return path.join(runtimeRegistryDir(profileId, configRoot), `${sessionId}.json`);
}

export async function registerRuntimeSession(
	entry: RuntimeRegistryEntry,
	configRoot = getConfigRootDir(),
): Promise<string> {
	const filePath = runtimeRegistryEntryPath(entry.session_id, entry.profile_id, configRoot);
	await Bun.write(filePath, `${JSON.stringify(entry, null, "\t")}\n`);
	return filePath;
}

export async function unregisterRuntimeSession(
	sessionId: string,
	profileId = "default",
	configRoot = getConfigRootDir(),
	expectedPid?: number,
): Promise<void> {
	const filePath = runtimeRegistryEntryPath(sessionId, profileId, configRoot);
	if (expectedPid !== undefined) {
		try {
			const entry = (await Bun.file(filePath).json()) as RuntimeRegistryEntry;
			if (entry.pid !== expectedPid) return;
		} catch {
			return;
		}
	}
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}

export async function listRuntimeRegistry(
	profileId = "default",
	configRoot = getConfigRootDir(),
): Promise<RuntimeRegistryEntry[]> {
	const dir = runtimeRegistryDir(profileId, configRoot);
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries: RuntimeRegistryEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		try {
			const entry = (await Bun.file(path.join(dir, name)).json()) as RuntimeRegistryEntry;
			entries.push(entry);
		} catch (err) {
			logger.debug("runtime registry entry unreadable", { name, error: String(err) });
		}
	}
	return entries;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Prune dead PIDs from the registry. Returns pruned session ids. */
export async function pruneDeadRegistryEntries(
	profileId = "default",
	configRoot = getConfigRootDir(),
): Promise<string[]> {
	const pruned: string[] = [];
	for (const entry of await listRuntimeRegistry(profileId, configRoot)) {
		if (isPidAlive(entry.pid)) continue;
		await unregisterRuntimeSession(entry.session_id, profileId, configRoot);
		pruned.push(entry.session_id);
	}
	return pruned;
}

export async function sendControlMessage(
	socketPath: string,
	message: RuntimeControlMessage,
	timeoutMs = 5000,
): Promise<RuntimeControlReply> {
	const { promise, resolve, reject } = Promise.withResolvers<RuntimeControlReply>();
	const socket = net.createConnection(socketPath);
	let settled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		settled = true;
		socket.destroy();
		reject(new Error(`runtime control timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	let buffer = "";
	socket.on("connect", () => {
		socket.write(`${JSON.stringify(message)}\n`);
	});
	socket.on("data", chunk => {
		buffer += chunk.toString("utf8");
		const nl = buffer.indexOf("\n");
		if (nl < 0) return;
		const line = buffer.slice(0, nl);
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		socket.end();
		try {
			resolve(JSON.parse(line) as RuntimeControlReply);
		} catch (err) {
			reject(err);
		}
	});
	socket.on("error", err => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		reject(err);
	});
	return promise;
}

/**
 * Broadcast reload to every live same-profile session.
 * ACK ≠ completed activation (I4).
 */
export async function broadcastReloadAll(options: {
	profileId?: string;
	configRoot?: string;
	reason?: string;
	timeoutMs?: number;
}): Promise<ReloadAllResult> {
	const profileId = options.profileId ?? "default";
	const configRoot = options.configRoot ?? getConfigRootDir();
	const pruned = await pruneDeadRegistryEntries(profileId, configRoot);
	const entries = await listRuntimeRegistry(profileId, configRoot);
	const result: ReloadAllResult = {
		requested: entries.map(e => e.session_id),
		acknowledged: [],
		pending: [],
		completed: [],
		failed: [],
		unreachable: [...pruned],
	};

	for (const entry of entries) {
		if (!isPidAlive(entry.pid)) {
			await unregisterRuntimeSession(entry.session_id, profileId, configRoot);
			result.unreachable.push(entry.session_id);
			continue;
		}
		const requestId = crypto.randomUUID();
		try {
			const reply = await sendControlMessage(
				entry.socket_path,
				{ type: "reload_request", request_id: requestId, reason: options.reason },
				options.timeoutMs ?? 5000,
			);
			if (reply.type !== "reload_ack") {
				result.failed.push({ session_id: entry.session_id, reason: `unexpected reply ${reply.type}` });
				continue;
			}
			result.acknowledged.push(entry.session_id);
			if (reply.status === "pending") result.pending.push(entry.session_id);
			else if (reply.status === "reloading") result.completed.push(entry.session_id);
			else result.failed.push({ session_id: entry.session_id, reason: reply.failure_reason ?? "failed" });
		} catch (err) {
			result.unreachable.push(entry.session_id);
			await unregisterRuntimeSession(entry.session_id, profileId, configRoot);
			logger.debug("runtime reload-all unreachable", {
				session_id: entry.session_id,
				error: String(err),
			});
		}
	}
	return result;
}

export class RuntimeControlServer {
	#server: net.Server | undefined;
	#socketPath: string;
	#handler: (message: RuntimeControlMessage) => Promise<RuntimeControlReply>;

	constructor(
		socketPath: string,
		handler: (message: RuntimeControlMessage) => Promise<RuntimeControlReply>,
	) {
		this.#socketPath = socketPath;
		this.#handler = handler;
	}

	get socketPath(): string {
		return this.#socketPath;
	}

	async start(): Promise<void> {
		await fs.mkdir(path.dirname(this.#socketPath), { recursive: true });
		try {
			await fs.unlink(this.#socketPath);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#server = net.createServer(socket => {
			let buffer = "";
			socket.on("data", async chunk => {
				buffer += chunk.toString("utf8");
				const nl = buffer.indexOf("\n");
				if (nl < 0) return;
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				try {
					const message = JSON.parse(line) as RuntimeControlMessage;
					const reply = await this.#handler(message);
					socket.write(`${JSON.stringify(reply)}\n`);
				} catch (err) {
					socket.write(
						`${JSON.stringify({
							type: "reload_ack",
							request_id: "unknown",
							status: "failed",
							failure_reason: String(err),
						})}\n`,
					);
				}
			});
		});
		this.#server.once("error", reject);
		this.#server.listen(this.#socketPath, () => {
			this.#server?.off("error", reject);
			resolve();
		});
		await promise;
	}

	async stop(): Promise<void> {
		const server = this.#server;
		this.#server = undefined;
		if (!server) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		server.close(() => resolve());
		await promise;
		// Do NOT unlink the path here. After warm reboot the successor may already
		// own this path; unlinking would delete the live listener's directory entry
		// while the inode remains open (ENOENT for new clients). start() unlinks.
	}
}
