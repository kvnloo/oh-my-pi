import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimeExtensionInfo, RuntimeSnapshot } from "@oh-my-pi/pi-coding-agent/live-runtime";
import {
	EXPECTED_EXTENSIONS,
	commitMatches,
	type ExpectedExtension,
	type ExtensionPresence,
} from "./manifest.ts";

export function findSnapshotExtension(snapshot: RuntimeSnapshot, id: string): RuntimeExtensionInfo | undefined {
	const needle = id.toLowerCase();
	return snapshot.extensions.find(ext => {
		const eid = ext.id.toLowerCase();
		return eid === needle || eid.includes(needle) || ext.path.toLowerCase().includes(needle);
	});
}

/** Resolve package root for an extension entry path (…/pkg/index.ts → …/pkg). */
export function extensionPackageRoot(extensionPath: string, fallbackLocation?: string): string {
	const resolved = path.resolve(extensionPath);
	if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
	let dir = path.dirname(resolved);
	for (let i = 0; i < 6; i++) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return fallbackLocation ? path.resolve(fallbackLocation) : path.dirname(resolved);
}

/** Git HEAD of the extension package (loaded implementation identity). */
export function resolveExtensionGitSha(extensionPath: string, fallbackLocation?: string): string | undefined {
	const root = extensionPackageRoot(extensionPath, fallbackLocation);
	try {
		const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return sha || undefined;
	} catch {
		return undefined;
	}
}

export function resolvePresence(
	ext: RuntimeExtensionInfo | undefined,
	expected?: ExpectedExtension,
	gitSha?: string,
): ExtensionPresence {
	if (!ext) return "MISSING";
	if (ext.stale) return "STALE";
	if (expected?.expectedCommit && !commitMatches(gitSha, expected.expectedCommit)) return "STALE";
	return "ACTIVE";
}

function shortSha(sha: string | undefined, len = 7): string {
	return sha && sha.length > 0 ? sha.slice(0, len) : "-";
}

export function formatRuntimeStatus(snapshot: RuntimeSnapshot): string {
	const lines: string[] = [];
	lines.push("OMP Runtime");
	lines.push("");
	lines.push("core");
	lines.push(`  pid              ${snapshot.process.pid}`);
	lines.push(`  version          ${snapshot.core.version}`);
	lines.push(`  git              ${snapshot.core.git_sha ?? "(unknown)"}`);
	lines.push(`  source           ${snapshot.core.source_root ?? "(unknown)"}`);
	lines.push(`  generation       ${snapshot.runtime.generation}`);
	lines.push(`  strategy         ${snapshot.runtime.strategy}`);
	lines.push("");
	lines.push("extensions");
	lines.push(`  ${"id".padEnd(20)} ${"git".padEnd(10)} ${"fp".padEnd(14)} presence`);
	for (const expected of EXPECTED_EXTENSIONS) {
		const found = findSnapshotExtension(snapshot, expected.id);
		const gitSha =
			(found ? resolveExtensionGitSha(found.path, expected.expectedLocation) : undefined) ??
			(expected.expectedLocation ? resolveExtensionGitSha(expected.expectedLocation) : undefined);
		const presence = resolvePresence(found, expected, gitSha);
		const fp = found?.fingerprint?.slice(0, 12) ?? "-";
		lines.push(
			`  ${expected.id.padEnd(20)} ${shortSha(gitSha, 7).padEnd(10)} ${fp.padEnd(14)} ${presence}`,
		);
	}
	for (const ext of snapshot.extensions) {
		const known = EXPECTED_EXTENSIONS.some(e => findSnapshotExtension({ ...snapshot, extensions: [ext] }, e.id));
		if (known) continue;
		const gitSha = resolveExtensionGitSha(ext.path);
		const presence = resolvePresence(ext);
		lines.push(
			`  ${ext.id.padEnd(20)} ${shortSha(gitSha, 7).padEnd(10)} ${ext.fingerprint.slice(0, 12).padEnd(14)} ${presence}`,
		);
	}
	lines.push("");
	lines.push("z0");
	lines.push("  (no external health probes configured)");
	lines.push("");
	lines.push("reload");
	const last = snapshot.last_activation;
	if (last) {
		lines.push(`  last              ${last.completed_at ?? last.started_at}`);
		lines.push(`  result            ${last.status}`);
		lines.push(`  pending           no`);
		if (last.failure_reason) lines.push(`  failure           ${last.failure_reason}`);
		if (last.duration_ms !== undefined) lines.push(`  duration_ms       ${last.duration_ms}`);
	} else {
		lines.push("  last              (none)");
		lines.push("  result            (none)");
		lines.push("  pending           no");
	}
	return lines.join("\n");
}

export function formatRuntimeStatusAll(
	rows: Array<{
		session_id: string;
		pid: number;
		core: string;
		generation: number;
		cognitive: ExtensionPresence;
		agy: ExtensionPresence;
		agy_sha: string;
		state: string;
	}>,
): string {
	const header = ["SESSION", "PID", "CORE", "GEN", "COGNITIVE", "AGY", "AGY_SHA", "STATE"];
	const body = rows.map(r => [
		r.session_id.slice(0, 8),
		String(r.pid),
		r.core.slice(0, 7),
		String(r.generation),
		r.cognitive,
		r.agy,
		r.agy_sha.slice(0, 7),
		r.state,
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i]!.length)));
	const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	return [fmt(header), ...body.map(fmt)].join("\n");
}

/** Derive cognitive/agy presence + agy sha from a session snapshot. */
export function summarizeExpected(snapshot: RuntimeSnapshot): {
	cognitive: ExtensionPresence;
	agy: ExtensionPresence;
	agy_sha: string;
} {
	const cognitiveExpected = EXPECTED_EXTENSIONS.find(e => e.id === "cognitive-state");
	const agyExpected = EXPECTED_EXTENSIONS.find(e => e.id === "agy-executor")!;
	const cognitiveExt = findSnapshotExtension(snapshot, "cognitive-state");
	const agyExt = findSnapshotExtension(snapshot, "agy-executor");
	const cognitiveSha = cognitiveExt
		? resolveExtensionGitSha(cognitiveExt.path, cognitiveExpected?.expectedLocation)
		: undefined;
	const agySha = agyExt
		? resolveExtensionGitSha(agyExt.path, agyExpected.expectedLocation)
		: resolveExtensionGitSha(agyExpected.expectedLocation);
	return {
		cognitive: resolvePresence(cognitiveExt, cognitiveExpected, cognitiveSha),
		agy: resolvePresence(agyExt, agyExpected, agySha),
		agy_sha: agySha ?? "-",
	};
}
