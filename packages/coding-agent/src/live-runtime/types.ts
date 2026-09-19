/** Stable schema id for runtime attestation snapshots. */
export const RUNTIME_SNAPSHOT_SCHEMA = "omp.runtime.v1" as const;

export type RuntimeActivationStrategy =
	| "startup"
	| "resource-reload"
	| "runtime-reload"
	| "warm-reboot";

export type RuntimeActivationStatus = "success" | "failed" | "pending" | "rejected";

export interface RuntimeProcessInfo {
	pid: number;
	started_at: string;
}

export interface RuntimeSessionInfo {
	session_id: string;
	cwd: string;
}

export interface RuntimeCoreInfo {
	version: string;
	git_sha?: string;
	source_root?: string;
	source_fingerprint: string;
}

export interface RuntimeGenerationInfo {
	generation: number;
	activated_at: string;
	strategy: RuntimeActivationStrategy;
}

export interface RuntimeExtensionInfo {
	id: string;
	path: string;
	fingerprint: string;
	loaded_at: string;
	disk_fingerprint: string;
	stale: boolean;
}

export interface RuntimeActivationEvent {
	from_generation: number;
	to_generation: number;
	strategy: RuntimeActivationStrategy;
	changed_files: string[];
	started_at: string;
	completed_at?: string;
	duration_ms?: number;
	status: RuntimeActivationStatus;
	failure_reason?: string;
	old_pid?: number;
	new_pid?: number;
	core_sha_before?: string;
	core_sha_after?: string;
	detect_ms?: number;
	validate_ms?: number;
	stage_ms?: number;
	handoff_ms?: number;
	activate_ms?: number;
	total_ms?: number;
	session_id?: string;
}

export interface RuntimeSnapshot {
	schema: typeof RUNTIME_SNAPSHOT_SCHEMA;
	process: RuntimeProcessInfo;
	session: RuntimeSessionInfo;
	core: RuntimeCoreInfo;
	runtime: RuntimeGenerationInfo;
	extensions: RuntimeExtensionInfo[];
	last_activation?: RuntimeActivationEvent;
}

export interface LoadedExtensionRecord {
	id: string;
	path: string;
	/** Fingerprint of the source generation that is currently active. */
	fingerprint: string;
	loaded_at: string;
}

export interface RuntimeAttestationInit {
	session_id: string;
	cwd: string;
	core_version: string;
	git_sha?: string;
	source_root?: string;
	source_fingerprint: string;
	extensions?: LoadedExtensionRecord[];
	strategy?: RuntimeActivationStrategy;
	started_at?: string;
	pid?: number;
	/** Active generation for warm-reboot handoff; defaults to 1. */
	generation?: number;
}
