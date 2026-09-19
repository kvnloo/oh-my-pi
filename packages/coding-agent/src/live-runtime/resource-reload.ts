import * as path from "node:path";
import { getExtensionNameFromPath } from "../discovery/helpers";
import { loadExtensions } from "../extensibility/extensions/loader";
import type { LoadExtensionsResult } from "../extensibility/extensions/types";
import { EventBus } from "../utils/event-bus";
import { fingerprintExtensionSource } from "./fingerprint";
import type { LoadedExtensionRecord } from "./types";

export interface CandidateValidationResult {
	ok: true;
	extensions: LoadExtensionsResult;
	records: LoadedExtensionRecord[];
	changed_files: string[];
}

export interface CandidateValidationFailure {
	ok: false;
	failure_reason: string;
	changed_files: string[];
}

/**
 * Import/load candidate extension paths in a validation scope.
 * Only call the live runtime reload after this succeeds (I3).
 */
export async function validateExtensionCandidates(
	paths: readonly string[],
	cwd: string,
	eventBus?: EventBus,
): Promise<CandidateValidationResult | CandidateValidationFailure> {
	const uniquePaths = dedupePaths(paths);
	const extensions = await loadExtensions(uniquePaths, cwd, eventBus ?? new EventBus());
	if (extensions.errors.length > 0) {
		const first = extensions.errors[0]!;
		return {
			ok: false,
			failure_reason: `${first.path}: ${first.error}`,
			changed_files: uniquePaths,
		};
	}
	const loadedAt = new Date().toISOString();
	const records: LoadedExtensionRecord[] = [];
	for (const ext of extensions.extensions) {
		const sourcePath = ext.resolvedPath.startsWith("<inline") ? ext.path : ext.resolvedPath;
		if (sourcePath.startsWith("<inline")) continue;
		records.push({
			id: getExtensionNameFromPath(sourcePath),
			path: sourcePath,
			fingerprint: await fingerprintExtensionSource(sourcePath),
			loaded_at: loadedAt,
		});
	}
	return {
		ok: true,
		extensions,
		records,
		changed_files: uniquePaths,
	};
}

export async function buildLoadedExtensionRecords(paths: readonly string[]): Promise<LoadedExtensionRecord[]> {
	const loadedAt = new Date().toISOString();
	const records: LoadedExtensionRecord[] = [];
	for (const extensionPath of dedupePaths(paths)) {
		records.push({
			id: getExtensionNameFromPath(extensionPath),
			path: path.resolve(extensionPath),
			fingerprint: await fingerprintExtensionSource(extensionPath),
			loaded_at: loadedAt,
		});
	}
	return records;
}

function dedupePaths(paths: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of paths) {
		const key = path.resolve(p).replaceAll("\\", "/");
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(path.resolve(p));
	}
	return out;
}
