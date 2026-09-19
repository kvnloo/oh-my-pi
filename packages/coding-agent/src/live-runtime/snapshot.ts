import * as path from "node:path";
import { fingerprintExtensionSource } from "./fingerprint";
import type {
	LoadedExtensionRecord,
	RuntimeActivationEvent,
	RuntimeActivationStrategy,
	RuntimeExtensionInfo,
	RuntimeSnapshot,
} from "./types";
import { RUNTIME_SNAPSHOT_SCHEMA } from "./types";

export interface BuildRuntimeSnapshotInput {
	pid: number;
	started_at: string;
	session_id: string;
	cwd: string;
	core_version: string;
	git_sha?: string;
	source_root?: string;
	source_fingerprint: string;
	generation: number;
	activated_at: string;
	strategy: RuntimeActivationStrategy;
	extensions: LoadedExtensionRecord[];
	last_activation?: RuntimeActivationEvent;
	/** Optional precomputed disk fingerprints (tests). */
	diskFingerprints?: Map<string, string>;
}

/**
 * Build a RuntimeSnapshot. Disk fingerprints are computed independently of
 * active fingerprints — reading a snapshot never mutates attestation state.
 */
export async function buildRuntimeSnapshot(input: BuildRuntimeSnapshotInput): Promise<RuntimeSnapshot> {
	if (input.generation < 1) {
		throw new Error(`runtime generation must be >= 1, got ${input.generation}`);
	}

	const extensions = await Promise.all(
		dedupeExtensions(input.extensions).map(async (ext): Promise<RuntimeExtensionInfo> => {
			const disk =
				input.diskFingerprints?.get(pathKey(ext.path)) ?? (await fingerprintExtensionSource(ext.path));
			return {
				id: ext.id,
				path: ext.path,
				fingerprint: ext.fingerprint,
				loaded_at: ext.loaded_at,
				disk_fingerprint: disk,
				stale: disk !== ext.fingerprint,
			};
		}),
	);

	const snapshot: RuntimeSnapshot = {
		schema: RUNTIME_SNAPSHOT_SCHEMA,
		process: {
			pid: input.pid,
			started_at: input.started_at,
		},
		session: {
			session_id: input.session_id,
			cwd: input.cwd,
		},
		core: {
			version: input.core_version,
			git_sha: input.git_sha,
			source_root: input.source_root,
			source_fingerprint: input.source_fingerprint,
		},
		runtime: {
			generation: input.generation,
			activated_at: input.activated_at,
			strategy: input.strategy,
		},
		extensions,
	};

	if (input.last_activation) {
		snapshot.last_activation = { ...input.last_activation };
	}

	return snapshot;
}

function dedupeExtensions(extensions: LoadedExtensionRecord[]): LoadedExtensionRecord[] {
	const seen = new Set<string>();
	const out: LoadedExtensionRecord[] = [];
	for (const ext of extensions) {
		const key = pathKey(ext.path);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(ext);
	}
	return out;
}

function pathKey(extensionPath: string): string {
	return path.resolve(extensionPath).replaceAll("\\", "/");
}
