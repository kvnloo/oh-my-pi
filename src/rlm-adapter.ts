/**
 * Thin adapter over coding-agent RlmStore.
 * Encodes evidence kind in `source` as `kind[/subtype]` — no z0-only store branches.
 */

import { createHash } from "node:crypto";
import type { EvidenceKind } from "./schema.ts";

export interface SpillRecord {
	id: string;
	handle: string;
	bytes: number;
	sha256: string;
	source?: string;
	text: string;
}

export interface SpillStore {
	put(text: string, source?: string): SpillRecord;
	get(handle: string): SpillRecord | undefined;
	search(handle: string, pattern: string, limit?: number): Array<{ index: number; text: string }>;
	readonly records: Map<string, SpillRecord>;
}

export function formatEvidenceSource(kind: EvidenceKind, subtype?: string): string {
	return subtype ? `${kind}/${subtype}` : kind;
}

export function parseEvidenceSource(source?: string): { kind: EvidenceKind; subtype?: string } {
	if (!source) return { kind: "other" };
	const [kind, ...rest] = source.split("/");
	const known: EvidenceKind[] = [
		"tool_output",
		"worker_transcript",
		"plan",
		"benchmark",
		"git_diff",
		"research",
		"verification",
		"other",
	];
	const k = (known.includes(kind as EvidenceKind) ? kind : "other") as EvidenceKind;
	return { kind: k, subtype: rest.length ? rest.join("/") : undefined };
}

/** In-memory store mirroring RlmStore.put semantics for unit tests / offline compile. */
export class LocalSpillStore implements SpillStore {
	#next = 1;
	readonly records = new Map<string, SpillRecord>();

	put(text: string, source?: string): SpillRecord {
		const id = String(this.#next++);
		const handle = `rlm://h/${id}`;
		const rec: SpillRecord = {
			id,
			handle,
			bytes: Buffer.byteLength(text, "utf8"),
			sha256: createHash("sha256").update(text).digest("hex"),
			source,
			text,
		};
		this.records.set(id, rec);
		this.records.set(handle, rec);
		return rec;
	}

	get(handle: string): SpillRecord | undefined {
		const key = handle.replace(/^rlm:\/\/h\//, "");
		return this.records.get(handle) ?? this.records.get(key);
	}

	search(handle: string, pattern: string, limit = 8): Array<{ index: number; text: string }> {
		const rec = this.get(handle);
		if (!rec) return [];
		const hits: Array<{ index: number; text: string }> = [];
		let from = 0;
		while (hits.length < limit) {
			const idx = rec.text.indexOf(pattern, from);
			if (idx < 0) break;
			hits.push({
				index: idx,
				text: rec.text.slice(idx, Math.min(rec.text.length, idx + 160)),
			});
			from = idx + Math.max(1, pattern.length);
		}
		return hits;
	}
}

/** Wrap an upstream RlmStore-like object. */
export function wrapRlmStore(store: {
	put(text: string, source?: string): { id: string; bytes: number; sha256: string; source?: string; text: string };
	get(handle: string): { id: string; bytes: number; sha256: string; source?: string; text: string } | undefined;
	search?(handle: string, pattern: string, limit?: number): Array<{ index: number; text: string }>;
	records: Map<string, unknown>;
}): SpillStore {
	const cache = new Map<string, SpillRecord>();
	return {
		records: cache,
		put(text, source) {
			const r = store.put(text, source);
			const handle = `rlm://h/${r.id}`;
			const rec: SpillRecord = { ...r, handle };
			cache.set(r.id, rec);
			cache.set(handle, rec);
			return rec;
		},
		get(handle) {
			const cached = cache.get(handle) ?? cache.get(handle.replace(/^rlm:\/\/h\//, ""));
			if (cached) return cached;
			const r = store.get(handle);
			if (!r) return undefined;
			const rec: SpillRecord = { ...r, handle: `rlm://h/${r.id}` };
			cache.set(r.id, rec);
			return rec;
		},
		search(handle, pattern, limit = 8) {
			if (store.search) return store.search(handle, pattern, limit);
			const rec = this.get(handle);
			if (!rec) return [];
			const idx = rec.text.indexOf(pattern);
			return idx < 0 ? [] : [{ index: idx, text: rec.text.slice(idx, idx + 160) }];
		},
	};
}
