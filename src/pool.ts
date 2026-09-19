/**
 * Persistent AGY process pool (stream-json stdin/stdout).
 * Keys: research:<repo> | implementation:<worktree>
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgyProcessState, AgyUsage } from "./types.ts";

export interface PoolKey {
	role: "research" | "implementation";
	cwd: string;
}

export function formatPoolKey(k: PoolKey): string {
	return `${k.role}:${k.cwd}`;
}

export interface TurnResult {
	conversation_id: string;
	status: string;
	response: string;
	structured_output?: unknown;
	usage?: AgyUsage;
	duration_seconds?: number;
	error?: string;
	model?: string;
	agent?: string;
	stderr?: string;
	pid?: number;
	denied_actions?: unknown[];
}

export interface AgySession {
	key: string;
	role: "research" | "implementation";
	cwd: string;
	state: AgyProcessState;
	conversation_id?: string;
	proc?: ChildProcessWithoutNullStreams;
	pid?: number;
	stderr_buf: string;
	queue: Array<{
		prompt: string;
		resolve: (r: TurnResult) => void;
		reject: (e: Error) => void;
		timeout_ms: number;
	}>;
	recent_failures: number;
	last_latency_ms?: number;
}

export interface PoolOptions {
	agy_bin?: string;
	research_agent?: string;
	implement_agent?: string;
	extra_args?: string[];
}

export class AgyPool {
	readonly sessions = new Map<string, AgySession>();
	readonly opts: Required<Pick<PoolOptions, "agy_bin" | "research_agent" | "implement_agent">> & PoolOptions;

	constructor(opts: PoolOptions = {}) {
		this.opts = {
			agy_bin: opts.agy_bin ?? process.env.AGY_BIN ?? "agy",
			research_agent: opts.research_agent ?? "z0-researcher",
			implement_agent: opts.implement_agent ?? "z0-implementer",
			extra_args: opts.extra_args ?? [],
		};
	}

	snapshot() {
		let ready = 0, busy = 0, failed = 0, queue = 0, failures = 0;
		const lats: number[] = [];
		for (const s of this.sessions.values()) {
			if (s.state === "READY") ready++;
			if (s.state === "BUSY" || s.state === "STARTING") busy++;
			if (s.state === "FAILED") failed++;
			queue += s.queue.length;
			failures += s.recent_failures;
			if (s.last_latency_ms != null) lats.push(s.last_latency_ms);
		}
		lats.sort((a, b) => a - b);
		return {
			agy_ready: ready,
			agy_busy: busy,
			agy_failed: failed,
			agy_queue_depth: queue,
			agy_recent_failures: failures,
			agy_p50_latency_ms: lats[Math.floor(lats.length * 0.5)],
		};
	}

	async ensure(key: PoolKey): Promise<AgySession> {
		const id = formatPoolKey(key);
		let s = this.sessions.get(id);
		if (s && s.state !== "FAILED" && s.state !== "UNLOADED" && s.proc && !s.proc.killed) return s;
		s = {
			key: id,
			role: key.role,
			cwd: key.cwd,
			state: "STARTING",
			queue: [],
			stderr_buf: "",
			recent_failures: s?.recent_failures ?? 0,
		};
		this.sessions.set(id, s);
		const agent = key.role === "research" ? this.opts.research_agent : this.opts.implement_agent;
		const mode = key.role === "research" ? "plan" : "accept-edits";
		const args = [
			`--mode=${mode}`,
			"--agent",
			agent,
			"--sandbox",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			...(this.opts.extra_args ?? []),
		];
		const proc = spawn(this.opts.agy_bin, args, {
			cwd: key.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});
		s.proc = proc;
		s.pid = proc.pid;
		const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => this.#onLine(s!, line));
		proc.stderr.on("data", (d) => {
			s!.stderr_buf += String(d);
			if (s!.stderr_buf.length > 32_000) s!.stderr_buf = s!.stderr_buf.slice(-32_000);
		});
		proc.on("exit", (code) => {
			s!.state = "FAILED";
			s!.recent_failures += 1;
			const err = new Error(`agy exited code=${code}`);
			while (s!.queue.length) s!.queue.shift()!.reject(err);
		});
		// Wait for init event (up to 15s); then READY even if mock emits late.
		const started = Date.now();
		while (s.state === "STARTING" && Date.now() - started < 15_000) {
			await new Promise((r) => setTimeout(r, 50));
			if (s.conversation_id) break;
		}
		if (s.state === "STARTING") s.state = "READY";
		return s;
	}

	#onLine(s: AgySession, line: string): void {
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}
		if (ev.event === "init") {
			s.conversation_id = ev.conversation_id ?? ev.init?.conversation_id;
			s.state = s.queue.length ? "BUSY" : "READY";
			return;
		}
		if (ev.event === "result") {
			const result = ev.result as TurnResult;
			s.conversation_id = result.conversation_id ?? s.conversation_id;
			result.stderr = s.stderr_buf;
			result.pid = s.pid;
			const job = s.queue.shift();
			s.state = s.queue.length ? "BUSY" : "READY";
			if (!job) return;
			job.resolve(result);
			return;
		}
	}

	async ask(key: PoolKey, prompt: string, timeout_ms = 120_000): Promise<TurnResult> {
		const s = await this.ensure(key);
		if (!s.proc?.stdin) throw new Error("agy stdin unavailable");
		s.state = "BUSY";
		const t0 = Date.now();
		const result = await new Promise<TurnResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error("agy turn timeout"));
			}, timeout_ms);
			s.queue.push({
				prompt,
				timeout_ms,
				resolve: (r) => {
					clearTimeout(timer);
					resolve(r);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			const msg = { event: "user", message: { content: prompt } };
			s.proc!.stdin.write(JSON.stringify(msg) + "\n");
		});
		s.last_latency_ms = Date.now() - t0;
		return result;
	}

	async drain(key?: PoolKey): Promise<void> {
		const targets = key
			? [this.sessions.get(formatPoolKey(key))].filter(Boolean)
			: [...this.sessions.values()];
		for (const s of targets) {
			if (!s) continue;
			s.state = "DRAINING";
			try {
				s.proc?.stdin.end();
			} catch {}
			s.proc?.kill("SIGTERM");
			s.state = "UNLOADED";
		}
	}
}

/** One-shot cold start using -p --output-format json (no persistent process). */
export async function coldPrint(opts: {
	agy_bin: string;
	cwd: string;
	mode: "plan" | "accept-edits";
	agent: string;
	prompt: string;
	json_schema_path?: string;
	timeout_ms?: number;
	/** Resume an existing AGY conversation (real-binary warm path). */
	conversation_id?: string;
	/** Resume last conversation in this cwd (--continue). */
	continue_last?: boolean;
	effort?: "low" | "medium" | "high";
	add_dirs?: string[];
}): Promise<TurnResult> {
	const args = [
		`--mode=${opts.mode}`,
		"--sandbox",
		"--output-format",
		"json",
		`--print-timeout=${Math.ceil((opts.timeout_ms ?? 180000) / 1000)}s`,
	];
	if (opts.agent && opts.agent !== "default") {
		args.push("--agent", opts.agent);
	}
	if (opts.json_schema_path) args.push("--json-schema", opts.json_schema_path);
	if (opts.conversation_id) args.push("--conversation", opts.conversation_id);
	else if (opts.continue_last) args.push("--continue");
	if (opts.effort) args.push(`--effort=${opts.effort}`);
	for (const d of opts.add_dirs ?? []) {
		args.push("--add-dir", d);
	}
	args.push("-p", opts.prompt);
	const proc = spawn(opts.agy_bin, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	proc.stdout.on("data", (d) => (stdout += d));
	proc.stderr.on("data", (d) => (stderr += d));
	const code: number = await new Promise((resolve) => {
		const t = setTimeout(() => {
			proc.kill("SIGKILL");
			resolve(124);
		}, opts.timeout_ms ?? 180000);
		proc.on("exit", (c) => {
			clearTimeout(t);
			resolve(c ?? 1);
		});
	});
	if (code === 124) {
		return {
			conversation_id: opts.conversation_id ?? "",
			status: "ERROR",
			response: "",
			error: "timeout",
			stderr,
			pid: proc.pid,
		};
	}
	try {
		const line = stdout.trim().split(/\n/).filter(Boolean).at(-1) ?? "{}";
		const env = JSON.parse(line);
		return {
			conversation_id: env.conversation_id ?? opts.conversation_id ?? "",
			status: env.status ?? (code === 0 ? "SUCCESS" : "ERROR"),
			response: env.response ?? "",
			structured_output: env.structured_output,
			usage: env.usage,
			duration_seconds: env.duration_seconds,
			error: env.error,
			model: env.model,
			agent: env.agent ?? opts.agent,
			denied_actions: env.denied_actions,
			stderr,
			pid: proc.pid,
		};
	} catch {
		return {
			conversation_id: opts.conversation_id ?? "",
			status: "ERROR",
			response: stdout,
			error: `malformed json (stderr=${stderr.slice(0, 200)})`,
			stderr,
			pid: proc.pid,
		};
	}
}
