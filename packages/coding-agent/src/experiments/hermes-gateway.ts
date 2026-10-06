import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { delimiter } from "node:path";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
	reject: (error: Error) => void;
	resolve: (value: unknown) => void;
	timer: NodeJS.Timeout;
}

export interface HermesGatewayEvent {
	payload?: JsonObject;
	session_id?: string;
	type: string;
}

const VALUE_REQUESTS = new Set([
	"display.install.sudo",
	"password",
	"preview.act",
	"preview.read",
	"secret",
	"sudo",
	"terminal.read",
	"tour",
	"vault.code",
	"vault.save_login",
	"vault.unlock_prompt",
	"window.read",
]);

/**
 * Safe fallback for server-to-client requests the experiment does not render yet.
 *
 * Approval is denied, clarify is cancelled, and sensitive string prompts are
 * skipped. Unknown request types are rejected with METHOD_NOT_FOUND instead of
 * inventing an answer.
 */
export function safeDeclineResult(method: string): JsonObject | undefined {
	if (method === "approval") return { choice: "deny" };
	if (method === "clarify") return {};
	if (VALUE_REQUESTS.has(method)) return { value: "" };
	return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function rpcError(error: unknown): Error {
	const body = asObject(error);
	const message = typeof body?.message === "string" ? body.message : "Hermes JSON-RPC request failed";
	return new Error(message);
}

/**
 * Minimal NDJSON JSON-RPC client for Hermes tui_gateway.
 *
 * This intentionally mirrors Hermes' own ui-tui transport instead of importing
 * Hermes frontend code. The Python gateway remains the single authority for
 * sessions, models, tools, approvals, and agent execution.
 */
export class HermesGatewayClient extends EventEmitter {
	#child: ChildProcessWithoutNullStreams | undefined;
	#nextId = 1;
	#pending = new Map<number, PendingRequest>();
	#ready = false;
	#readyPromise: Promise<void>;
	#resolveReady!: () => void;
	#rejectReady!: (error: Error) => void;

	constructor() {
		super();
		this.#readyPromise = new Promise<void>((resolve, reject) => {
			this.#resolveReady = resolve;
			this.#rejectReady = reject;
		});
	}

	get ready(): boolean {
		return this.#ready;
	}

	start(): void {
		if (this.#child) return;

		const python = process.env.HERMES_PYTHON?.trim() || (process.platform === "win32" ? "python" : "python3");
		const sourceRoot =
			process.env.HERMES_PYTHON_SRC_ROOT?.trim() ||
			process.env.HERMES_ROOT?.trim() ||
			process.env.HERMES_AGENT_ROOT?.trim();
		const spawnCwd = sourceRoot || process.cwd();
		const env = { ...process.env };

		if (sourceRoot) {
			const current = env.PYTHONPATH?.trim();
			env.PYTHONPATH = current ? sourceRoot + delimiter + current : sourceRoot;
			env.HERMES_PYTHON_SRC_ROOT = sourceRoot;
		}

		const child = spawn(python, ["-m", "tui_gateway.entry"], {
			cwd: spawnCwd,
			env,
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
			this.#failAll(error);
			if (!this.#ready) this.#rejectReady(error);
			this.emit("error", error);
		});

		child.on("exit", (code, signal) => {
			if (this.#child !== child) return;
			this.#child = undefined;
			const detail = signal ? " signal=" + signal : "";
			const error = new Error("Hermes gateway exited code=" + String(code ?? "null") + detail);
			this.#failAll(error);
			if (!this.#ready) this.#rejectReady(error);
			this.emit("exit", code);
		});
	}

	waitReady(): Promise<void> {
		return this.#readyPromise;
	}

	request<T = unknown>(method: string, params: JsonObject = {}, timeoutMs = 120_000): Promise<T> {
		const child = this.#child;
		if (!child?.stdin || child.killed || child.exitCode !== null) {
			return Promise.reject(new Error("Hermes gateway is not running"));
		}

		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Hermes JSON-RPC timeout: " + method));
			}, timeoutMs);
			timer.unref?.();

			this.#pending.set(id, {
				reject,
				resolve: value => resolve(value as T),
				timer,
			});

			child.stdin.write(JSON.stringify({ id, jsonrpc: "2.0", method, params }) + "\n");
		});
	}

	close(): void {
		const child = this.#child;
		this.#child = undefined;
		this.#ready = false;
		if (child && !child.killed && child.exitCode === null) child.kill();
		this.#failAll(new Error("Hermes gateway closed"));
	}

	#handleLine(line: string): void {
		let frame: JsonObject;
		try {
			const parsed = JSON.parse(line) as unknown;
			const body = asObject(parsed);
			if (!body) throw new Error("frame is not an object");
			frame = body;
		} catch (error) {
			this.emit("protocolError", error instanceof Error ? error : new Error(String(error)));
			return;
		}

		if (typeof frame.id === "number" && ("result" in frame || "error" in frame) && typeof frame.method !== "string") {
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			this.#pending.delete(frame.id);
			clearTimeout(pending.timer);
			if ("error" in frame && frame.error != null) pending.reject(rpcError(frame.error));
			else pending.resolve(frame.result);
			return;
		}

		if (frame.method === "event") {
			const event = asObject(frame.params);
			if (!event || typeof event.type !== "string") return;
			if (event.type === "gateway.ready" && !this.#ready) {
				this.#ready = true;
				this.#resolveReady();
			}
			this.emit("event", event as unknown as HermesGatewayEvent);
			return;
		}

		if ((typeof frame.id === "number" || typeof frame.id === "string") && typeof frame.method === "string") {
			this.#handleServerRequest(frame.id, frame.method);
		}
	}

	#handleServerRequest(id: number | string, method: string): void {
		const child = this.#child;
		if (!child?.stdin) return;

		const result = safeDeclineResult(method);
		if (result !== undefined) {
			child.stdin.write(JSON.stringify({ id, jsonrpc: "2.0", result }) + "\n");
			this.emit("serverRequestDeclined", method);
			return;
		}

		child.stdin.write(
			JSON.stringify({
				error: { code: -32601, message: "OMP Hermes experiment does not implement server request: " + method },
				id,
				jsonrpc: "2.0",
			}) + "\n",
		);
		this.emit("serverRequestDeclined", method);
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}
