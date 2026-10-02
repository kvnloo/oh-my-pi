import type { EvidenceRef } from "./types.ts";

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, args: string[], env?: Record<string, string>) => Promise<CommandResult>;

export interface ResolveResult {
	evidence: EvidenceRef[];
	raw_source_reads: number;
	gaps: string[];
	retrieval_capability: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Map a z0int.context_resolve.v1 packet dict. Does not invent refs. */
export function evidenceFromContextResolve(packet: unknown): ResolveResult {
	const root = asRecord(packet);
	const evidence = root?.evidence;
	const refs: EvidenceRef[] = [];
	if (Array.isArray(evidence)) {
		for (const item of evidence) {
			const row = asRecord(item);
			if (!row) continue;
			const sourceId = stringField(row, "source_id");
			const locator = stringField(row, "locator");
			if (!sourceId || !locator) continue;
			refs.push({
				source_id: sourceId,
				source_version: stringField(row, "source_version") ?? "unknown",
				locator,
				trust_class: (stringField(row, "trust_class") as EvidenceRef["trust_class"]) ?? "unknown",
				observed_at: stringField(row, "observed_at") ?? "unknown",
				excerpt: stringField(row, "excerpt"),
				note: stringField(row, "note"),
				plane: "EXTERNAL",
			});
		}
	}
	let raw = 0;
	const recipe = asRecord(root?.recipe);
	const ops = recipe?.operations;
	if (Array.isArray(ops)) {
		for (const op of ops) {
			const row = asRecord(op);
			if (row?.op === "exact_path" && row.hit === true) raw += 1;
		}
	}
	const gaps = Array.isArray(root?.unresolved_gaps)
		? root.unresolved_gaps.filter((gap): gap is string => typeof gap === "string")
		: [];
	return { evidence: refs, raw_source_reads: raw, gaps, retrieval_capability: "z0int.context_resolve.v1" };
}

/** Map AgentsView content-search matches. Locators only; snippets stay off committed receipts. */
export function evidenceFromAgentsView(payload: unknown, observedAt: string): EvidenceRef[] {
	const root = asRecord(payload);
	const matches = Array.isArray(payload) ? payload : root?.matches;
	if (!Array.isArray(matches)) return [];
	const refs: EvidenceRef[] = [];
	for (const item of matches) {
		const row = asRecord(item);
		if (!row) continue;
		const sessionId = stringField(row, "session_id");
		if (!sessionId) continue;
		const ordinal = typeof row.ordinal === "number" ? row.ordinal : 0;
		const range = Array.isArray(row.ordinal_range) ? row.ordinal_range : [ordinal, ordinal];
		const start = typeof range[0] === "number" ? range[0] : ordinal;
		const end = typeof range[1] === "number" ? range[1] : ordinal;
		refs.push({
			source_id: `agentsview:${sessionId}`,
			source_version: `ordinal=${ordinal}`,
			locator: `${sessionId}@${start}-${end}`,
			trust_class: "index_hit",
			observed_at: observedAt,
			excerpt: stringField(row, "snippet"),
			note: row.subordinate === true ? "subordinate" : undefined,
			plane: "EXTERNAL",
		});
	}
	return refs;
}

export async function resolveFromZ0int(
	query: string,
	run: CommandRunner,
	options: { pythonPath?: string; projectRoot?: string; python?: string; exactPath?: string } = {},
): Promise<ResolveResult> {
	const python = options.python ?? "python3";
	const script = [
		"import json, sys",
		"from z0int.context_resolve import InformationNeed, resolve_context",
		"root = sys.argv[2] or None",
		"exact = sys.argv[3] if len(sys.argv) > 3 else ''",
		"needs = [InformationNeed(id='exact', description=exact, kind='exact_path', path=exact, required=True)] if exact else None",
		"packet = resolve_context(needs=needs, query=None if needs else sys.argv[1], project_root=root, allow_qmd=False, allow_memory=False, use_cache=False)",
		"json.dump(packet.to_dict(), sys.stdout)",
	].join("\n");
	const env = options.pythonPath ? { PYTHONPATH: options.pythonPath } : undefined;
	const result = await run(python, ["-c", script, query, options.projectRoot ?? "", options.exactPath ?? ""], env);
	if (result.code !== 0 || result.stdout.trim().length === 0) {
		return {
			evidence: [],
			raw_source_reads: 0,
			gaps: [`z0int: resolver unavailable (${result.code})`],
			retrieval_capability: "z0int.context_resolve.v1",
		};
	}
	return evidenceFromContextResolve(JSON.parse(result.stdout) as unknown);
}

export async function resolveFromAgentsView(
	query: string,
	run: CommandRunner,
	options: { bin?: string; observedAt?: string } = {},
): Promise<ResolveResult> {
	const bin = options.bin ?? "agentsview";
	const result = await run(bin, ["session", "search", query, "--fts", "--json", "--limit", "5"]);
	if (result.code !== 0 || result.stdout.trim().length === 0) {
		return {
			evidence: [],
			raw_source_reads: 0,
			gaps: [`agentsview: search unavailable (${result.code})`],
			retrieval_capability: "agentsview.search",
		};
	}
	return {
		evidence: evidenceFromAgentsView(JSON.parse(result.stdout) as unknown, options.observedAt ?? "unknown"),
		raw_source_reads: 0,
		gaps: [],
		retrieval_capability: "agentsview.search",
	};
}
