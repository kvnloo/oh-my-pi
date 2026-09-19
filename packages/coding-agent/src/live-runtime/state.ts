import type {
	LoadedExtensionRecord,
	RuntimeActivationEvent,
	RuntimeActivationStrategy,
	RuntimeAttestationInit,
	RuntimeSnapshot,
} from "./types";
import { buildRuntimeSnapshot } from "./snapshot";

/**
 * Process/session-scoped runtime attestation.
 * Transcript/session state is durable; this tracks replaceable runtime generation.
 */
export class RuntimeAttestationState {
	#pid: number;
	#startedAt: string;
	#sessionId: string;
	#cwd: string;
	#coreVersion: string;
	#gitSha: string | undefined;
	#sourceRoot: string | undefined;
	#sourceFingerprint: string;
	#generation: number;
	#activatedAt: string;
	#strategy: RuntimeActivationStrategy;
	#extensions = new Map<string, LoadedExtensionRecord>();
	#lastActivation: RuntimeActivationEvent | undefined;
	#pendingActivation: RuntimeActivationEvent | undefined;
	#busy = false;
	#reloadPending = false;

	constructor(init: RuntimeAttestationInit) {
		this.#pid = init.pid ?? process.pid;
		this.#startedAt = init.started_at ?? new Date().toISOString();
		this.#sessionId = init.session_id;
		this.#cwd = init.cwd;
		this.#coreVersion = init.core_version;
		this.#gitSha = init.git_sha;
		this.#sourceRoot = init.source_root;
		this.#sourceFingerprint = init.source_fingerprint;
		this.#generation = 1;
		this.#activatedAt = this.#startedAt;
		this.#strategy = init.strategy ?? "startup";
		this.#setExtensions(init.extensions ?? []);
	}

	get generation(): number {
		return this.#generation;
	}

	get sessionId(): string {
		return this.#sessionId;
	}

	get pid(): number {
		return this.#pid;
	}

	get lastActivation(): RuntimeActivationEvent | undefined {
		return this.#lastActivation;
	}

	get pendingActivation(): RuntimeActivationEvent | undefined {
		return this.#pendingActivation;
	}

	get reloadPending(): boolean {
		return this.#reloadPending;
	}

	get isBusy(): boolean {
		return this.#busy;
	}

	setBusy(busy: boolean): void {
		this.#busy = busy;
	}

	setSession(sessionId: string, cwd: string): void {
		this.#sessionId = sessionId;
		this.#cwd = cwd;
	}

	setCoreIdentity(input: {
		version?: string;
		git_sha?: string;
		source_root?: string;
		source_fingerprint?: string;
	}): void {
		if (input.version !== undefined) this.#coreVersion = input.version;
		if (input.git_sha !== undefined) this.#gitSha = input.git_sha;
		if (input.source_root !== undefined) this.#sourceRoot = input.source_root;
		if (input.source_fingerprint !== undefined) this.#sourceFingerprint = input.source_fingerprint;
	}

	replaceExtensions(extensions: LoadedExtensionRecord[]): void {
		this.#setExtensions(extensions);
	}

	markPendingActivation(event: Omit<RuntimeActivationEvent, "status"> & { status?: RuntimeActivationEvent["status"] }): void {
		this.#pendingActivation = { ...event, status: event.status ?? "pending" };
		this.#reloadPending = true;
	}

	/**
	 * Record a successful activation. Generation advances exactly once here —
	 * never before the new generation is known-good.
	 */
	commitActivation(input: {
		strategy: RuntimeActivationStrategy;
		changed_files?: string[];
		started_at: string;
		completed_at?: string;
		failure_reason?: never;
		old_pid?: number;
		new_pid?: number;
		core_sha_before?: string;
		core_sha_after?: string;
		detect_ms?: number;
		validate_ms?: number;
		stage_ms?: number;
		handoff_ms?: number;
		activate_ms?: number;
		extensions?: LoadedExtensionRecord[];
	}): number {
		const from = this.#generation;
		const to = from + 1;
		const completedAt = input.completed_at ?? new Date().toISOString();
		const durationMs = Date.parse(completedAt) - Date.parse(input.started_at);
		this.#generation = to;
		this.#activatedAt = completedAt;
		this.#strategy = input.strategy;
		if (input.extensions) this.#setExtensions(input.extensions);
		if (input.new_pid !== undefined) this.#pid = input.new_pid;
		this.#lastActivation = {
			from_generation: from,
			to_generation: to,
			strategy: input.strategy,
			changed_files: input.changed_files ?? [],
			started_at: input.started_at,
			completed_at: completedAt,
			duration_ms: Number.isFinite(durationMs) ? durationMs : undefined,
			status: "success",
			old_pid: input.old_pid,
			new_pid: input.new_pid,
			core_sha_before: input.core_sha_before,
			core_sha_after: input.core_sha_after,
			detect_ms: input.detect_ms,
			validate_ms: input.validate_ms,
			stage_ms: input.stage_ms,
			handoff_ms: input.handoff_ms,
			activate_ms: input.activate_ms,
			total_ms: Number.isFinite(durationMs) ? durationMs : undefined,
			session_id: this.#sessionId,
		};
		this.#pendingActivation = undefined;
		this.#reloadPending = false;
		return to;
	}

	/** Record a failed activation without advancing generation. */
	rejectActivation(input: {
		strategy: RuntimeActivationStrategy;
		changed_files?: string[];
		started_at: string;
		completed_at?: string;
		failure_reason: string;
		from_generation?: number;
		to_generation?: number;
		old_pid?: number;
		new_pid?: number;
		core_sha_before?: string;
		core_sha_after?: string;
		detect_ms?: number;
		validate_ms?: number;
		stage_ms?: number;
		handoff_ms?: number;
		activate_ms?: number;
	}): void {
		const completedAt = input.completed_at ?? new Date().toISOString();
		const durationMs = Date.parse(completedAt) - Date.parse(input.started_at);
		this.#lastActivation = {
			from_generation: input.from_generation ?? this.#generation,
			to_generation: input.to_generation ?? this.#generation,
			strategy: input.strategy,
			changed_files: input.changed_files ?? [],
			started_at: input.started_at,
			completed_at: completedAt,
			duration_ms: Number.isFinite(durationMs) ? durationMs : undefined,
			status: "failed",
			failure_reason: input.failure_reason,
			old_pid: input.old_pid,
			new_pid: input.new_pid,
			core_sha_before: input.core_sha_before,
			core_sha_after: input.core_sha_after,
			detect_ms: input.detect_ms,
			validate_ms: input.validate_ms,
			stage_ms: input.stage_ms,
			handoff_ms: input.handoff_ms,
			activate_ms: input.activate_ms,
			total_ms: Number.isFinite(durationMs) ? durationMs : undefined,
			session_id: this.#sessionId,
		};
		this.#pendingActivation = undefined;
		this.#reloadPending = false;
	}

	clearReloadPending(): void {
		this.#reloadPending = false;
		if (this.#pendingActivation?.status === "pending") {
			this.#pendingActivation = undefined;
		}
	}

	/** Pure read: build snapshot; never mutates active fingerprints. */
	async snapshot(): Promise<RuntimeSnapshot> {
		return buildRuntimeSnapshot({
			pid: this.#pid,
			started_at: this.#startedAt,
			session_id: this.#sessionId,
			cwd: this.#cwd,
			core_version: this.#coreVersion,
			git_sha: this.#gitSha,
			source_root: this.#sourceRoot,
			source_fingerprint: this.#sourceFingerprint,
			generation: this.#generation,
			activated_at: this.#activatedAt,
			strategy: this.#strategy,
			extensions: [...this.#extensions.values()],
			last_activation: this.#lastActivation,
		});
	}

	#setExtensions(extensions: LoadedExtensionRecord[]): void {
		this.#extensions.clear();
		const seen = new Set<string>();
		for (const ext of extensions) {
			const key = pathKey(ext.path);
			if (seen.has(key)) continue;
			seen.add(key);
			this.#extensions.set(key, {
				id: ext.id,
				path: ext.path,
				fingerprint: ext.fingerprint,
				loaded_at: ext.loaded_at,
			});
		}
	}
}

function pathKey(extensionPath: string): string {
	return extensionPath.replaceAll("\\", "/");
}

let activeState: RuntimeAttestationState | undefined;

export function getRuntimeAttestation(): RuntimeAttestationState | undefined {
	return activeState;
}

export function setRuntimeAttestation(state: RuntimeAttestationState | undefined): void {
	activeState = state;
}

export function initRuntimeAttestation(init: RuntimeAttestationInit): RuntimeAttestationState {
	activeState = new RuntimeAttestationState(init);
	return activeState;
}

/** Test seam. */
export function resetRuntimeAttestation(): void {
	activeState = undefined;
}
