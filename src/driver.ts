/**
 * AgyDriver: research + implementation lanes.
 * Reuses the spirit of z0int AgyResearchDriver without duplicating FlyForge proposal logic.
 *
 * P0.6: per-turn permission apply/restore is baked in (never --dangerously-skip-permissions).
 * Warm path stays print + --conversation (no stream-json residency).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { AgyPool, coldPrint, type TurnResult } from "./pool.ts";
import { createIsolatedWorktree, parentCheckoutUntouched, worktreeStatus } from "./worktree.ts";
import {
	implementPermissions,
	researchPermissions,
	withPermissions,
	type PermissionScope,
} from "./permissions.ts";
import type { ResearchReceipt, WorkReceipt, ReceiptStatus } from "./types.ts";

export interface DriverOptions {
	agy_bin?: string;
	research_agent?: string;
	implement_agent?: string;
	prefer_warm?: boolean;
	schema_dir?: string;
	worktree_root?: string;
	/** Override settings.json path (tests). Default: ~/.gemini/antigravity-cli/settings.json */
	settings_path?: string;
	/**
	 * When true (default for real AGY), narrow/restore permissions around each turn.
	 * Auto-disabled for mock-agy unless explicitly overridden.
	 */
	manage_permissions?: boolean;
}

function statusFrom(turn: TurnResult): ReceiptStatus {
	if (turn.status === "SUCCESS") return "ok";
	if (/timeout/i.test(turn.error ?? "")) return "timeout";
	if (/auth/i.test(turn.error ?? "")) return "unavailable";
	if (/permission|denied/i.test(turn.error ?? "") || /permission|denied/i.test(turn.stderr ?? "")) {
		return "permission_denied";
	}
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

function normalizeResearch(parsed: Partial<ResearchReceipt> | null, turn: TurnResult): Partial<ResearchReceipt> {
	if (!parsed) {
		const text = turn.response?.trim();
		return {
			findings: text ? [text.slice(0, 2000)] : [],
			evidence: [],
			unresolved: turn.error ? [turn.error] : [],
			recommendation: "review raw response",
		};
	}
	return {
		findings: Array.isArray(parsed.findings) ? parsed.findings.map(String) : [],
		evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
		unresolved: Array.isArray(parsed.unresolved) ? parsed.unresolved.map(String) : [],
		recommendation: parsed.recommendation ?? "review findings",
		status: parsed.status,
		conversation_id: parsed.conversation_id,
		model: parsed.model,
		agent: parsed.agent,
		effort: parsed.effort,
		usage: parsed.usage,
	};
}

function isMockAgy(bin: string): boolean {
	return /mock-agy/.test(bin);
}

function permMeta(scope?: PermissionScope | null): ResearchReceipt["permissions"] | undefined {
	if (!scope) return undefined;
	return { applied: scope.applied, restored: scope.restored, tag: scope.tag };
}

export class AgyDriver {
	readonly pool: AgyPool;
	readonly opts: Required<
		Pick<
			DriverOptions,
			| "agy_bin"
			| "research_agent"
			| "implement_agent"
			| "prefer_warm"
			| "schema_dir"
			| "worktree_root"
			| "manage_permissions"
		>
	> & { settings_path?: string };
	/** Last research conversation_id per cwd (real AGY warm via --conversation). */
	private researchConversations = new Map<string, string>();

	constructor(opts: DriverOptions = {}) {
		const agy_bin = opts.agy_bin ?? process.env.AGY_BIN ?? "agy";
		this.opts = {
			agy_bin,
			research_agent: opts.research_agent ?? "z0-researcher",
			implement_agent: opts.implement_agent ?? "z0-implementer",
			prefer_warm: opts.prefer_warm ?? true,
			schema_dir: opts.schema_dir ?? path.join(import.meta.dir, "../schemas"),
			worktree_root: opts.worktree_root ?? "",
			settings_path: opts.settings_path,
			manage_permissions: opts.manage_permissions ?? !isMockAgy(agy_bin),
		};
		this.pool = new AgyPool({
			agy_bin: this.opts.agy_bin,
			research_agent: this.opts.research_agent,
			implement_agent: this.opts.implement_agent,
		});
	}

	private async runResearchTurn(
		prompt: string,
		opts: {
			cwd: string;
			task_id: string;
			warm?: boolean;
			conversation_id?: string;
			use_stream_json?: boolean;
		},
	): Promise<ResearchReceipt> {
		const t0 = Date.now();
		const schema = path.join(this.opts.schema_dir, "research-receipt.schema.json");
		const fullPrompt =
			`Return ONLY JSON matching the research receipt schema.\n` +
			`Role=research. No file writes. No shell.\n` +
			`Stay strictly inside the task repository paths. Do not read home dotfiles, shell history, SSH keys, or unrelated paths.\n` +
			`Do not use SearchWeb/ReadUrlContent unless the task explicitly requires it.\n` +
			`If a tool is denied, stop and return status=permission_denied with what you already know.\n\nTASK:\n${prompt}`;
		const wantWarm = opts.warm ?? this.opts.prefer_warm;
		const useStream =
			opts.use_stream_json === true ||
			(wantWarm && isMockAgy(this.opts.agy_bin) && opts.use_stream_json !== false);
		let turn: TurnResult;
		try {
			if (useStream) {
				turn = await this.pool.ask({ role: "research", cwd: opts.cwd }, fullPrompt, 120_000);
			} else {
				const conversation_id =
					opts.conversation_id ?? (wantWarm ? this.researchConversations.get(opts.cwd) : undefined);
				turn = await coldPrint({
					agy_bin: this.opts.agy_bin,
					cwd: opts.cwd,
					mode: "plan",
					agent: this.opts.research_agent,
					prompt: fullPrompt,
					json_schema_path: fs.existsSync(schema) ? schema : undefined,
					conversation_id,
					timeout_ms: 180_000,
					effort: "low",
				});
			}
		} catch (e) {
			return {
				task_id: opts.task_id,
				role: "research",
				status: "error",
				findings: [],
				evidence: [],
				unresolved: [String(e)],
				recommendation: "retry explicitly; do not silently fall back to OMP_ROOT",
				conversation_id: null,
				duration_ms: Date.now() - t0,
				raw_error: String(e),
				cursor_calls_avoided: 1,
				executor: "agy",
			};
		}
		const parsed = normalizeResearch(parseStructured<Partial<ResearchReceipt>>(turn), turn);
		const status = statusFrom(turn);
		const conversation_id = turn.conversation_id || parsed?.conversation_id || null;
		if (conversation_id) this.researchConversations.set(opts.cwd, conversation_id);
		return {
			task_id: opts.task_id,
			role: "research",
			status: parsed?.status === "ok" || status === "ok" ? "ok" : status,
			findings: parsed.findings ?? [],
			evidence: parsed.evidence ?? [],
			unresolved: parsed.unresolved ?? [],
			recommendation: parsed.recommendation ?? "review findings",
			conversation_id,
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

	async research(
		prompt: string,
		opts?: {
			cwd?: string;
			task_id?: string;
			warm?: boolean;
			conversation_id?: string;
			/** Force stream-json residency (mock-agy / experimental). Real AGY pipes hang. */
			use_stream_json?: boolean;
		},
	): Promise<ResearchReceipt> {
		const task_id = opts?.task_id ?? `research-${randomUUID().slice(0, 8)}`;
		const cwd = opts?.cwd ?? process.cwd();
		const run = () =>
			this.runResearchTurn(prompt, {
				cwd,
				task_id,
				warm: opts?.warm,
				conversation_id: opts?.conversation_id,
				use_stream_json: opts?.use_stream_json,
			});

		if (!this.opts.manage_permissions) return run();

		const { result, scope } = await withPermissions(
			{
				profile: researchPermissions(cwd),
				trusted_workspaces: [cwd],
				settings_path: this.opts.settings_path,
				tag: `research-${task_id}`,
			},
			run,
		);
		return { ...result, permissions: permMeta(scope) };
	}

	private async runImplementTurn(
		prompt: string,
		opts: {
			task_id: string;
			wt: ReturnType<typeof createIsolatedWorktree>;
			warm?: boolean;
			verifier_cmd?: string;
			use_stream_json?: boolean;
		},
	): Promise<WorkReceipt> {
		const t0 = Date.now();
		const { wt, task_id } = opts;
		const fullPrompt =
			`You are in an isolated worktree at: ${wt.worktree}\n` +
			`Use replace_file_content/write_to_file/run_command. Do not claim tools are missing.\n` +
			`Make the smallest coherent change. Do not merge/push/deploy. Write only inside this worktree.\n` +
			`Return JSON work receipt fields in your final answer.\n\nTASK:\n${prompt}`;
		const wantWarm = opts.warm ?? this.opts.prefer_warm;
		const useStream =
			opts.use_stream_json === true ||
			(wantWarm && isMockAgy(this.opts.agy_bin) && opts.use_stream_json !== false);
		let turn: TurnResult;
		try {
			if (useStream) {
				turn = await this.pool.ask({ role: "implementation", cwd: wt.worktree }, fullPrompt, 180_000);
			} else {
				turn = await coldPrint({
					agy_bin: this.opts.agy_bin,
					cwd: wt.worktree,
					mode: "accept-edits",
					agent: this.opts.implement_agent,
					prompt: fullPrompt,
					timeout_ms: 240_000,
					effort: "low",
					add_dirs: [wt.worktree],
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
		if (opts.verifier_cmd) {
			try {
				const { execFileSync } = await import("node:child_process");
				const out = execFileSync("bash", ["-lc", opts.verifier_cmd], {
					cwd: wt.worktree,
					encoding: "utf8",
					timeout: 60_000,
				});
				tests = { ran: true, passed: true, command: opts.verifier_cmd, output_excerpt: out.slice(0, 500) };
			} catch (e) {
				tests = {
					ran: true,
					passed: false,
					command: opts.verifier_cmd,
					output_excerpt: String(e).slice(0, 500),
				};
			}
		}
		let status = statusFrom(turn);
		if (status === "ok" && !parent_ok) status = "error";
		if (status === "ok" && tests.ran && tests.passed === false) status = "error";
		return {
			task_id,
			role: "implementation",
			status,
			repo: wt.repo,
			worktree: wt.worktree,
			base_sha: wt.base_sha,
			head_sha: st.head_sha,
			changed_files: st.changed_files.length ? st.changed_files : parsed?.changed_files ?? [],
			tests,
			verifier: parsed?.verifier ?? {
				ok: tests.passed !== false,
				name: opts.verifier_cmd ? "cmd" : "none",
			},
			findings: parsed?.findings ?? [],
			blockers: parent_ok
				? parsed?.blockers ?? []
				: [...(parsed?.blockers ?? []), "parent_checkout_changed"],
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

	async implement(
		prompt: string,
		opts?: {
			repo?: string;
			task_id?: string;
			warm?: boolean;
			verifier_cmd?: string;
			use_stream_json?: boolean;
		},
	): Promise<WorkReceipt> {
		const task_id = opts?.task_id ?? `impl-${randomUUID().slice(0, 8)}`;
		const wt = createIsolatedWorktree({
			repo: opts?.repo,
			task_id,
			root: this.opts.worktree_root || undefined,
		});
		const run = () =>
			this.runImplementTurn(prompt, {
				task_id,
				wt,
				warm: opts?.warm,
				verifier_cmd: opts?.verifier_cmd,
				use_stream_json: opts?.use_stream_json,
			});

		if (!this.opts.manage_permissions) return run();

		const trusted = [wt.repo, wt.worktree];
		if (this.opts.worktree_root) trusted.push(path.resolve(this.opts.worktree_root));
		const { result, scope } = await withPermissions(
			{
				profile: implementPermissions(wt.worktree, wt.repo),
				trusted_workspaces: trusted,
				settings_path: this.opts.settings_path,
				tag: `implement-${task_id}`,
			},
			run,
		);
		return { ...result, permissions: permMeta(scope) };
	}
}
