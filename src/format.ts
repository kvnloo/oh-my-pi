import type { RuntimeExtensionInfo, RuntimeSnapshot } from "@oh-my-pi/pi-coding-agent/live-runtime";
import { EXPECTED_EXTENSIONS, type ExtensionPresence } from "./manifest.ts";

export function resolvePresence(ext: RuntimeExtensionInfo | undefined): ExtensionPresence {
	if (!ext) return "MISSING";
	if (ext.stale) return "STALE";
	return "ACTIVE";
}

export function findSnapshotExtension(snapshot: RuntimeSnapshot, id: string): RuntimeExtensionInfo | undefined {
	const needle = id.toLowerCase();
	return snapshot.extensions.find(ext => {
		const eid = ext.id.toLowerCase();
		return eid === needle || eid.includes(needle) || ext.path.toLowerCase().includes(needle);
	});
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
	for (const expected of EXPECTED_EXTENSIONS) {
		const found = findSnapshotExtension(snapshot, expected.id);
		const presence = resolvePresence(found);
		const fp = found?.fingerprint?.slice(0, 12) ?? expected.expectedCommit?.slice(0, 12) ?? "-";
		lines.push(`  ${expected.id.padEnd(20)} ${fp.padEnd(14)} ${presence}`);
	}
	for (const ext of snapshot.extensions) {
		const known = EXPECTED_EXTENSIONS.some(e => findSnapshotExtension({ ...snapshot, extensions: [ext] }, e.id));
		if (known) continue;
		const presence = resolvePresence(ext);
		lines.push(`  ${ext.id.padEnd(20)} ${ext.fingerprint.slice(0, 12).padEnd(14)} ${presence}`);
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
		state: string;
	}>,
): string {
	const header = ["SESSION", "PID", "CORE", "GEN", "COGNITIVE", "AGY", "STATE"];
	const body = rows.map(r => [
		r.session_id.slice(0, 8),
		String(r.pid),
		r.core.slice(0, 7),
		String(r.generation),
		r.cognitive,
		r.agy,
		r.state,
	]);
	const widths = header.map((h, i) => Math.max(h.length, ...body.map(row => row[i]!.length)));
	const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
	return [fmt(header), ...body.map(fmt)].join("\n");
}
