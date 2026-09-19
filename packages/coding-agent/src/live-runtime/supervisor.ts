import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";

export type WarmRebootPhase =
	| "watching"
	| "validating"
	| "generation_ready_pending_activation"
	| "activating"
	| "stable"
	| "rejected";

export interface WarmRebootHandoff {
	cwd: string;
	session_id: string;
	session_path?: string;
	model?: string;
	thinking_level?: string;
	service_tier?: string;
	composer_draft?: string;
	from_generation: number;
	to_generation: number;
	core_sha_before?: string;
}

export interface WarmRebootMetrics {
	detect_ms?: number;
	validate_ms?: number;
	stage_ms?: number;
	handoff_ms?: number;
	activate_ms?: number;
	total_ms?: number;
}

export interface CandidateReadySignal {
	pid: number;
	generation: number;
	session_id: string;
	core_sha?: string;
	source_fingerprint?: string;
}

export interface SupervisorOptions {
	watchRoots: string[];
	ignoreGlobs?: string[];
	debounceMs?: number;
	spawnCandidate: (handoff: WarmRebootHandoff) => Promise<{ pid: number; ready: Promise<CandidateReadySignal> }>;
	isSessionBusy: () => boolean;
	waitForSafeBoundary: () => Promise<void>;
	killProcess: (pid: number) => Promise<void>;
	validateCandidate: () => Promise<{ ok: true } | { ok: false; failure_reason: string }>;
	onStatus?: (message: string) => void;
	getActivePid: () => number;
	getGeneration: () => number;
	getSessionIdentity: () => Promise<Omit<WarmRebootHandoff, "from_generation" | "to_generation">>;
	onActivated?: (signal: CandidateReadySignal, metrics: WarmRebootMetrics) => void;
	onRejected?: (reason: string, metrics: WarmRebootMetrics) => void;
}

const DEFAULT_IGNORE = [
	"**/.git/**",
	"**/node_modules/**",
	"**/target/**",
	"**/logs/**",
	"**/sessions/**",
	"**/artifacts/**",
	"**/tmp/**",
	"**/*.map",
];

/**
 * Supervised warm process replacement (Tier C). Never kills the old child
 * before the candidate emits READY.
 */
export class LiveRuntimeSupervisor {
	#options: SupervisorOptions;
	#phase: WarmRebootPhase = "stable";
	#debounceTimer: ReturnType<typeof setTimeout> | undefined;
	#pendingChangeFiles: string[] = [];
	#watchers: fsSync.FSWatcher[] = [];
	#closed = false;
	#activationLock: Promise<void> = Promise.resolve();

	constructor(options: SupervisorOptions) {
		this.#options = options;
	}

	get phase(): WarmRebootPhase {
		return this.#phase;
	}

	async start(): Promise<void> {
		const debounceMs = this.#options.debounceMs ?? 200;
		for (const root of this.#options.watchRoots) {
			try {
				// node:fs.watch (callback FSWatcher) — not fs/promises.watch (async iterator).
				const watcher = fsSync.watch(root, { recursive: true }, (_event, filename) => {
					if (!filename) return;
					const full = path.join(root, filename.toString());
					if (shouldIgnore(full, this.#options.ignoreGlobs ?? DEFAULT_IGNORE)) return;
					this.#pendingChangeFiles.push(full);
					if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
					this.#debounceTimer = setTimeout(() => {
						void this.#onDebouncedChange();
					}, debounceMs);
				});
				this.#watchers.push(watcher);
			} catch (err) {
				logger.warn("live-runtime supervisor watch failed", { root, error: String(err) });
			}
		}
		this.#phase = "watching";
	}

	async stop(): Promise<void> {
		this.#closed = true;
		if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
		for (const watcher of this.#watchers) watcher.close();
		this.#watchers = [];
	}

	/** Test/manual seam: inject a core change burst. */
	async notifyCoreChange(changedFiles: string[]): Promise<void> {
		this.#pendingChangeFiles.push(...changedFiles);
		await this.#onDebouncedChange();
	}

	async #onDebouncedChange(): Promise<void> {
		if (this.#closed) return;
		const changed = [...new Set(this.#pendingChangeFiles.splice(0))];
		if (changed.length === 0) return;
		this.#activationLock = this.#activationLock.then(() => this.#runWarmReboot(changed));
		await this.#activationLock;
	}

	async #runWarmReboot(changedFiles: string[]): Promise<void> {
		const started = Date.now();
		const detectMs = 0;
		const fromGeneration = this.#options.getGeneration();
		const oldPid = this.#options.getActivePid();
		this.#phase = "validating";
		this.#options.onStatus?.(`validating generation ${fromGeneration + 1}`);

		const validateStarted = Date.now();
		const validation = await this.#options.validateCandidate();
		const validateMs = Date.now() - validateStarted;
		if (!validation.ok) {
			this.#phase = "rejected";
			this.#options.onStatus?.(`⚠ generation ${fromGeneration + 1} rejected\n  ${validation.failure_reason}`);
			this.#options.onRejected?.(validation.failure_reason, {
				detect_ms: detectMs,
				validate_ms: validateMs,
				total_ms: Date.now() - started,
			});
			this.#phase = "watching";
			return;
		}

		if (this.#options.isSessionBusy()) {
			this.#phase = "generation_ready_pending_activation";
			this.#options.onStatus?.(`GENERATION_READY_PENDING_ACTIVATION ${fromGeneration + 1}`);
			await this.#options.waitForSafeBoundary();
		}

		this.#phase = "activating";
		const identity = await this.#options.getSessionIdentity();
		const handoff: WarmRebootHandoff = {
			...identity,
			from_generation: fromGeneration,
			to_generation: fromGeneration + 1,
		};

		const stageStarted = Date.now();
		let candidate: { pid: number; ready: Promise<CandidateReadySignal> };
		try {
			candidate = await this.#options.spawnCandidate(handoff);
		} catch (err) {
			this.#phase = "rejected";
			const reason = err instanceof Error ? err.message : String(err);
			this.#options.onRejected?.(reason, {
				detect_ms: detectMs,
				validate_ms: validateMs,
				total_ms: Date.now() - started,
			});
			this.#phase = "watching";
			return;
		}
		const stageMs = Date.now() - stageStarted;

		const handoffStarted = Date.now();
		let ready: CandidateReadySignal;
		try {
			ready = await candidate.ready;
		} catch (err) {
			await this.#options.killProcess(candidate.pid);
			this.#phase = "rejected";
			const reason = err instanceof Error ? err.message : String(err);
			this.#options.onStatus?.(`⚠ generation ${fromGeneration + 1} rejected\n  ${reason}`);
			this.#options.onRejected?.(reason, {
				detect_ms: detectMs,
				validate_ms: validateMs,
				stage_ms: stageMs,
				total_ms: Date.now() - started,
			});
			this.#phase = "watching";
			return;
		}
		const handoffMs = Date.now() - handoffStarted;

		const activateStarted = Date.now();
		// Only after READY: terminate old child.
		if (oldPid !== ready.pid) {
			await this.#options.killProcess(oldPid);
		}
		const activateMs = Date.now() - activateStarted;
		const metrics: WarmRebootMetrics = {
			detect_ms: detectMs,
			validate_ms: validateMs,
			stage_ms: stageMs,
			handoff_ms: handoffMs,
			activate_ms: activateMs,
			total_ms: Date.now() - started,
		};
		this.#options.onActivated?.(ready, metrics);
		this.#phase = "watching";
		void changedFiles;
	}
}

function shouldIgnore(filePath: string, patterns: string[]): boolean {
	const normalized = filePath.replaceAll("\\", "/");
	for (const pattern of patterns) {
		const bare = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "");
		if (normalized.includes(`/${bare}/`) || normalized.includes(`/${bare}`)) return true;
		if (bare.startsWith("*.") && normalized.endsWith(bare.slice(1))) return true;
	}
	return false;
}

export function classifyChangeTier(changedFiles: string[]): "A" | "C" {
	for (const file of changedFiles) {
		const n = file.replaceAll("\\", "/");
		if (
			n.includes("/packages/coding-agent/src/") ||
			n.includes("/packages/tui/src/") ||
			n.includes("/packages/agent") ||
			n.includes("/packages/ai/src/") ||
			n.includes("/packages/utils/src/") ||
			n.includes("/crates/") ||
			n.includes("/packages/natives/")
		) {
			return "C";
		}
	}
	return "A";
}

export async function readHandoffFile(filePath: string): Promise<WarmRebootHandoff | undefined> {
	try {
		return (await Bun.file(filePath).json()) as WarmRebootHandoff;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function writeHandoffFile(filePath: string, handoff: WarmRebootHandoff): Promise<void> {
	await Bun.write(filePath, `${JSON.stringify(handoff, null, "\t")}\n`);
}
