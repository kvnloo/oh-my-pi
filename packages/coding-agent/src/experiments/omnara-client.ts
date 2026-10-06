import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

export interface OmnaraSseFrame {
	event: string;
	id?: string;
	data: string;
}

export interface OmnaraStreamState {
	state: "connected" | "reconnecting";
	reconnected?: boolean;
}

export interface OmnaraStreamOptions {
	afterSequence?: number;
	signal?: AbortSignal;
	onConnectionStateChange?: (state: OmnaraStreamState) => void;
}

export interface OmnaraBridgeCommand {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
}

interface StreamNotification {
	event: string;
	id?: string;
	data: unknown;
}

function requireAgentID(env: NodeJS.ProcessEnv): string {
	const value = env.OMNARA_AGENT_ID?.trim();
	if (!value) throw new Error("Set OMNARA_AGENT_ID");
	return value;
}

/**
 * Resolve the Omnara-owned bridge process.
 *
 * OMNARA_ROOT dogfoods the companion source branch; otherwise an installed
 * `omnara` CLI is used. Legacy experiment env names are translated into the
 * official CLI names so existing dogfood commands keep working.
 */
export function resolveOmnaraBridgeCommand(env: NodeJS.ProcessEnv = process.env): OmnaraBridgeCommand {
	const agentID = requireAgentID(env);
	const childEnv = { ...env };
	if (!childEnv.OMNARA_API_KEY && childEnv.OMNARA_TOKEN) childEnv.OMNARA_API_KEY = childEnv.OMNARA_TOKEN;
	if (!childEnv.OMNARA_API_URL && childEnv.OMNARA_API) childEnv.OMNARA_API_URL = childEnv.OMNARA_API;

	const root = env.OMNARA_ROOT?.trim();
	if (root) {
		return {
			command: env.OMNARA_PNPM?.trim() || "pnpm",
			args: [
				"--dir",
				join(root, "frontend"),
				"--filter",
				"omnara",
				"run",
				"omnara",
				"--",
				"agents",
				"bridge-omp",
				agentID,
			],
			env: childEnv,
		};
	}

	return {
		command: env.OMNARA_BIN?.trim() || "omnara",
		args: ["agents", "bridge-omp", agentID],
		env: childEnv,
	};
}

function asObject(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function messageFromError(value: unknown, fallback: string): string {
	const body = asObject(value);
	return typeof body.message === "string" && body.message ? body.message : fallback;
}

/**
 * Thin client for the Omnara-owned renderer bridge.
 *
 * OMP no longer implements Omnara auth, REST paths, generated schemas or SSE
 * recovery. It only consumes a small NDJSON JSON-RPC protocol and translates
 * the resulting native Omnara events into AgentSession events.
 */
export class OmnaraClient extends EventEmitter {
	#child: ChildProcessWithoutNullStreams | undefined;
	#nextID = 1;
	#pending = new Map<number, PendingRequest>();
	#ready = false;
	#readyPromise: Promise<void>;
	#resolveReady!: () => void;
	#rejectReady!: (error: Error) => void;
	#streamQueue: OmnaraSseFrame[] = [];
	#streamWaiters: Array<(value: IteratorResult<OmnaraSseFrame>) => void> = [];
	#streamError: Error | undefined;
	#connectionListener: ((state: OmnaraStreamState) => void) | undefined;
	#closed = false;

	constructor(command: OmnaraBridgeCommand = resolveOmnaraBridgeCommand()) {
		super();
		this.#readyPromise = new Promise<void>((resolve, reject) => {
			this.#resolveReady = resolve;
			this.#rejectReady = reject;
		});
		this.#start(command);
	}

	#start(spec: OmnaraBridgeCommand): void {
		const child = spawn(spec.command, spec.args, {
			env: spec.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#child = child;

		const stdout = createInterface({ input: child.stdout });
		stdout.on("line", line => this.#handleLine(line));

		const stderr = createInterface({ input: child.stderr });
		stderr.on("line", line => {
			const text = line.trim();
			if (text) this.emit("stderr", text);
		});

		child.on("error", error => {
			this.#fail(error);
		});
		child.on("exit", (code, signal) => {
			if (this.#child !== child || this.#closed) return;
			const suffix = signal ? " signal=" + signal : "";
			this.#fail(
				new Error(
					"Omnara bridge exited code=" +
						String(code ?? "null") +
						suffix +
						". Set OMNARA_ROOT to the companion Omnara checkout or install a CLI with agents bridge-omp.",
				),
			);
		});
	}

	async #request<T = JsonObject>(method: string, params: JsonObject = {}, timeoutMs = 120_000): Promise<T> {
		await this.#readyPromise;
		const child = this.#child;
		if (!child?.stdin || child.killed || child.exitCode !== null) {
			throw new Error("Omnara bridge is not running");
		}

		const id = this.#nextID++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Omnara bridge timeout: " + method));
			}, timeoutMs);
			timer.unref?.();
			this.#pending.set(id, {
				resolve: value => resolve(value as T),
				reject,
				timer,
			});
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
		});
	}

	#handleLine(line: string): void {
		let frame: JsonObject;
		try {
			frame = asObject(JSON.parse(line));
		} catch {
			this.emit("protocolError", new Error("Invalid Omnara bridge frame"));
			return;
		}

		if (typeof frame.id === "number" && ("result" in frame || "error" in frame)) {
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			this.#pending.delete(frame.id);
			clearTimeout(pending.timer);
			if (frame.error != null) {
				pending.reject(new Error(messageFromError(frame.error, "Omnara bridge request failed")));
			} else {
				pending.resolve(frame.result);
			}
			return;
		}

		if (typeof frame.method !== "string") return;
		const params = asObject(frame.params);
		if (frame.method === "ready") {
			if (!this.#ready) {
				this.#ready = true;
				this.#resolveReady();
			}
			return;
		}
		if (frame.method === "stream.connection") {
			const state = params.state;
			if (state === "connected" || state === "reconnecting") {
				this.#connectionListener?.({
					state,
					reconnected: params.reconnected === true,
				});
			}
			return;
		}
		if (frame.method === "stream.error") {
			this.#streamError = new Error(messageFromError(params, "Omnara event stream failed"));
			this.#flushStreamWaiters();
			return;
		}
		if (frame.method === "stream.event") {
			const event = params.event;
			if (typeof event !== "string") return;
			const streamFrame: OmnaraSseFrame = {
				event,
				...(typeof params.id === "string" ? { id: params.id } : {}),
				data: JSON.stringify(params.data ?? {}),
			};
			const waiter = this.#streamWaiters.shift();
			if (waiter) waiter({ value: streamFrame, done: false });
			else this.#streamQueue.push(streamFrame);
		}
	}

	#nextStreamFrame(): Promise<IteratorResult<OmnaraSseFrame>> {
		const queued = this.#streamQueue.shift();
		if (queued) return Promise.resolve({ value: queued, done: false });
		if (this.#streamError) return Promise.reject(this.#streamError);
		if (this.#closed) return Promise.resolve({ value: undefined, done: true });
		return new Promise(resolve => this.#streamWaiters.push(resolve));
	}

	#flushStreamWaiters(): void {
		while (this.#streamWaiters.length) {
			const waiter = this.#streamWaiters.shift();
			if (waiter) waiter({ value: undefined, done: true });
		}
	}

	#fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		if (!this.#ready) this.#rejectReady(error);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		this.#streamError = error;
		this.#flushStreamWaiters();
		this.emit("error", error);
	}

	getAgent<T = JsonObject>(): Promise<T> {
		return this.#request<T>("agent.get");
	}

	listRecentEvents<T = JsonObject>(limit = 100): Promise<T> {
		return this.#request<T>("events.list", { limit });
	}

	listToolCalls<T = JsonObject>(): Promise<T> {
		return this.#request<T>("tool_calls.list", { limit: 500 });
	}

	listOpenInteractions<T = JsonObject>(): Promise<T> {
		return this.#request<T>("interactions.list", { limit: 500 });
	}

	createInput<T = JsonObject>(
		text: string,
		idempotencyKey: string,
		deliveryMode: "queued" | "steering" = "queued",
	): Promise<T> {
		return this.#request<T>("input.create", {
			text,
			idempotency_key: idempotencyKey,
			delivery_mode: deliveryMode,
		});
	}

	cancel<T = JsonObject>(): Promise<T> {
		return this.#request<T>("agent.cancel");
	}

	resolveInteraction<T = JsonObject>(
		interactionAgentID: string,
		interactionID: string,
		answers: Array<{ option_indices: number[]; text?: string }>,
	): Promise<T> {
		return this.#request<T>("interaction.resolve", {
			target_agent_id: interactionAgentID,
			interaction_id: interactionID,
			answers,
		});
	}

	async *streamEvents(options: OmnaraStreamOptions = {}): AsyncGenerator<OmnaraSseFrame> {
		await this.#readyPromise;
		this.#streamQueue = [];
		this.#streamError = undefined;
		this.#connectionListener = options.onConnectionStateChange;
		const signal = options.signal;

		const abort = () => {
			void this.#request("stream.stop").catch(() => undefined);
			this.#flushStreamWaiters();
		};
		signal?.addEventListener("abort", abort, { once: true });

		await this.#request("stream.start", {
			after_sequence: Math.max(0, Math.trunc(options.afterSequence ?? 0)),
		});

		try {
			while (!signal?.aborted && !this.#closed) {
				const next = await this.#nextStreamFrame();
				if (next.done) {
					if (this.#streamError) throw this.#streamError;
					break;
				}
				yield next.value;
			}
		} finally {
			signal?.removeEventListener("abort", abort);
			this.#connectionListener = undefined;
			if (!this.#closed) await this.#request("stream.stop").catch(() => undefined);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const child = this.#child;
		this.#child = undefined;
		if (child && !child.killed && child.exitCode === null) child.kill();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Omnara bridge closed"));
		}
		this.#pending.clear();
		this.#flushStreamWaiters();
	}
}
