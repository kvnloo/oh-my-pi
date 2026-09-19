/**
 * AgyDriver: research + implementation lanes.
 * Reuses the spirit of z0int AgyResearchDriver without duplicating FlyForge proposal logic.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AgyPool, coldPrint, type TurnResult } from "./pool.ts";
import { createIsolatedWorktree, parentCheckoutUntouched, worktreeStatus } from "./worktree.ts";
import type { ResearchReceipt, WorkReceipt, ReceiptStatus } from "./types.ts";

export interface DriverOptions {
	agy_bin?: string;
	research_agent?: string;
	implement_agent?: string;
	prefer_warm?: boolean;
	schema_dir?: string;
	worktree_root?: string;
}

function statusFrom(turn: TurnResult): ReceiptStatus {
	if (turn.status === "SUCCESS") return "ok";
	if (/timeout/i.test(turn.error ?? "")) return "timeout";
	if (/auth/i.test(turn.error ?? "")) return "unavailable";
	if (/permission|denied/i.test(turn.error ?? "")) return "permission_denied";
	if (/malformed|json/i.test(turn.error ?? "")) return "malformed";
	return "error";
}

function parseStructured<T>(turn: TurnResult): T | null {
	if (turn.structured_output && typeof turn.structured_output === "object") {
		return turn.structured_output as T;
	}
	try {
		return JSON.parse(turn.response) as T;
	} catch {
		return null;
	}
}

export class AgyDriver {
	readonly pool: AgyPool;
	readonly opts: Required<DriverOptions>;

	constructor(opts: DriverOptions = {}) {
		this.opts = {
			agy_bin: opts.agy_bin ?? process.env.AGY_BIN ?? "agy",
			research_agent: opts.research_agent ?? "z0-researcher",
			implement_agent: opts.implement_agent ?? "z0-implementer",
			prefer_warm: opts.prefer_warm ?? true,
			schema_dir: opts.schema_dir ?? path.join(import.meta.dir, "../schemas"),
			worktree_root: opts.worktree_root ?? "",
		};
		this.pool = new AgyPool({
			agy_bin: this.opts.agy_bin,
			research_agent: this.opts.research_agent,
			implement_agent: this.opts.implement_agent,
		});
	}

	async research(prompt: string, opts?: { cwd?: string; task_id?: string; warm?: boolean }): Promise<ResearchReceipt> {
		const task_id = opts?.task_id ?? `research-${randomUUID().slice(0, 8)}`;
		const cwd = opts?.cwd ?? process.cwd();
		const t0 = Date.now();
		const schema = path.join(this.opts.schema_dir, "research-receipt.schema.json");
		const fullPrompt =
			`Return ONLY JSON matching the research receipt schema.\n` +
			`Role=research. No file writes. No shell.\n\nTASK:\n${prompt}`;
		let turn: TurnResult;
		try {
			if (opts?.warm ?? this.opts.prefer_warm) {
				turn = await this.pool.ask({ role: "research", cwd }, fullPrompt, 120_000);
			} else {
				turn = await coldPrint({
					agy_bin: this.opts.agy_bin,
					cwd,
					mode: "plan",
					agent: this.opts.research_agent,
					prompt: fullPrompt,
					json_schema_path: fs.existsSync(schema) ? schema : undefined,
				});
			}
		} catch (e) {
			return {
				task_id,
				role: "research",
				status: "error",
				findings: [],
				evidence: [],
				unresolved: [String(e)],
				recommendation: "retry or fall back to OMP_ROOT",
				conversation_id: null,
				duration_ms: Date.now() - t0,
				raw_error: String(e),
				cursor_calls_avoided: 1,
				executor: "agy",
			};
		}
		const parsed = parseStructured<Partial<ResearchReceipt>>(turn);
		const status = statusFrom(turn);
		return {
			task_id,
			role: "research",
			status: parsed?.status === "ok" || status === "ok" ? "ok" : status,
			findings: parsed?.findings ?? (turn.response ? [turn.response.slice(0, 500)] : []),
			evidence: parsed?.evidence ?? [],
			unresolved: parsed?.unresolved ?? [],
			recommendation: parsed?.recommendation ?? "review findings",
			conversation_id: turn.conversation_id || parsed?.conversation_id || null,
			model: turn.model ?? parsed?.model ?? null,
			agent: turn.agent ?? this.opts.research_agent,
			effort: parsed?.effort ?? null,
			usage: turn.usage ?? parsed?.usage ?? null,
			duration_ms: Date.now() - t0,
			raw_error: turn.error,
			cursor_calls_avoided: 1,
			executor: "agy",
		};
	}

	async implement(
		prompt: string,
		opts?: { repo?: string; task_id?: string; warm?: boolean; verifier_cmd?: string },
	): Promise<WorkReceipt> {
		const task_id = opts?.task_id ?? `impl-${randomUUID().slice(0, 8)}`;
		const t0 = Date.now();
		const wt = createIsolatedWorktree({
			repo: opts?.repo,
			task_id,
			root: this.opts.worktree_root || undefined,
		});
		const fullPrompt =
			`You are in an isolated worktree. Make the smallest coherent change.\n` +
			`Do not merge/push/deploy. Stay inside this worktree.\n` +
			`Return JSON work receipt fields in your final answer.\n\nTASK:\n${prompt}`;
		let turn: TurnResult;
		try {
			if (opts?.warm ?? this.opts.prefer_warm) {
				turn = await this.pool.ask({ role: "implementation", cwd: wt.worktree }, fullPrompt, 180_000);
			} else {
				turn = await coldPrint({
					agy_bin: this.opts.agy_bin,
					cwd: wt.worktree,
					mode: "accept-edits",
					agent: this.opts.implement_agent,
					prompt: fullPrompt,
				});
			}
		} catch (e) {
			return {
				task_id,
				role: "implementation",
				status: "error",
				repo: wt.repo,
				worktree: wt.worktree,
				base_sha: wt.base_sha,
				head_sha: null,
				changed_files: [],
				tests: { ran: false },
				verifier: { ok: false, detail: String(e) },
				findings: [],
				blockers: [String(e)],
				artifacts: [],
				conversation_id: null,
				duration_ms: Date.now() - t0,
				raw_error: String(e),
				parent_checkout_untouched: true,
				cursor_calls_avoided: 1,
				executor: "agy",
			};
		}
		const st = worktreeStatus(wt.worktree);
		const parent_ok = parentCheckoutUntouched(wt.repo, wt.base_sha);
		const parsed = parseStructured<Partial<WorkReceipt>>(turn);
		let tests = parsed?.tests ?? { ran: false };
		if (opts?.verifier_cmd) {
			try {
				const { execFileSync } = await import("node:child_process");
				const out = execFileSync("bash", ["-lc", opts.verifier_cmd], {
					cwd: wt.worktree,
					encoding: "utf8",
					timeout: 60_000,
				});
				tests = { ran: true, passed: true, command: opts.verifier_cmd, output_excerpt: out.slice(0, 500) };
			} catch (e) {
				tests = { ran: true, passed: false, command: opts.verifier_cmd, output_excerpt: String(e).slice(0, 500) };
			}
		}
		const status = statusFrom(turn);
		return {
			task_id,
			role: "implementation",
			status: status === "ok" && parent_ok ? "ok" : status === "ok" ? "error" : status,
			repo: wt.repo,
			worktree: wt.worktree,
			base_sha: wt.base_sha,
			head_sha: st.head_sha,
			changed_files: st.changed_files.length ? st.changed_files : parsed?.changed_files ?? [],
			tests,
			verifier: parsed?.verifier ?? { ok: tests.passed !== false, name: opts?.verifier_cmd ? "cmd" : "none" },
			findings: parsed?.findings ?? [],
			blockers: parent_ok ? parsed?.blockers ?? [] : ["parent_checkout_changed"],
			artifacts: parsed?.artifacts ?? [],
			conversation_id: turn.conversation_id || null,
			model: turn.model ?? null,
			agent: turn.agent ?? this.opts.implement_agent,
			effort: null,
			usage: turn.usage ?? null,
			duration_ms: Date.now() - t0,
			raw_error: turn.error,
			parent_checkout_untouched: true,
			cursor_calls_avoided: 1,
			executor: "agy",
		};
	}
}
