import { createHash } from "node:crypto";
import type { EvidenceRef } from "./types.ts";
import { UNIFIED_RECEIPT_SCHEMA } from "./types.ts";
import type { UnifiedEvidenceRef, UnifiedMemoryReceipt } from "./types.ts";

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export function locatorHash(locator: string): string {
	return createHash("sha256").update(locator).digest("hex");
}

export function toEvidenceRef(ref: EvidenceRef): UnifiedEvidenceRef {
	return {
		source_id: ref.source_id,
		source_version: ref.source_version,
		trust_class: ref.trust_class,
		locator_hash: locatorHash(ref.locator),
	};
}

export function assertShaRevision(revision: string): string {
	if (!SHA_RE.test(revision)) {
		throw new Error(`harness_revision must be a git SHA, got ${revision}`);
	}
	return revision.toLowerCase();
}

interface SchemaDoc {
	required?: string[];
	properties?: Record<string, { const?: string; enum?: string[]; type?: string; minimum?: number; pattern?: string }>;
}

/** Validate one row against the pinned z0eval receipt schema object. */
export function validateUnifiedReceipt(row: unknown, schema: SchemaDoc): string[] {
	const errors: string[] = [];
	if (row === null || typeof row !== "object" || Array.isArray(row)) return ["receipt is not an object"];
	const record = row as Record<string, unknown>;
	const allowed = new Set(Object.keys(schema.properties ?? {}));
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) errors.push(`unexpected property ${key}`);
	}
	for (const key of schema.required ?? []) {
		if (!(key in record)) errors.push(`missing ${key}`);
	}
	if (record.schema !== UNIFIED_RECEIPT_SCHEMA) errors.push("schema const mismatch");
	const harness = schema.properties?.harness?.enum;
	if (harness && !harness.includes(String(record.harness))) errors.push("harness not in enum");
	if (typeof record.harness_revision !== "string" || !SHA_RE.test(record.harness_revision)) {
		errors.push("harness_revision is not a git SHA");
	}
	for (const key of ["retrieval_ok", "injected", "answer_supported", "verified", "abstained", "duplicate_injection"] as const) {
		if (typeof record[key] !== "boolean") errors.push(`${key} is not boolean`);
	}
	for (const key of ["question_id", "session_id", "trace_id", "retrieval_capability"] as const) {
		if (typeof record[key] !== "string") errors.push(`${key} is not string`);
	}
	if (typeof record.latency_ms !== "number" || record.latency_ms < 0) errors.push("latency_ms invalid");
	if (!Number.isInteger(record.context_bytes) || (record.context_bytes as number) < 0) errors.push("context_bytes invalid");
	if (!Number.isInteger(record.raw_source_reads) || (record.raw_source_reads as number) < 0) {
		errors.push("raw_source_reads invalid");
	}
	if (!Array.isArray(record.evidence_refs)) {
		errors.push("evidence_refs is not an array");
	} else {
		for (const item of record.evidence_refs) {
			if (item === null || typeof item !== "object" || Array.isArray(item)) {
				errors.push("evidence_refs item is not an object");
				continue;
			}
			const ref = item as Record<string, unknown>;
			for (const key of ["source_id", "source_version", "trust_class"] as const) {
				if (typeof ref[key] !== "string") errors.push(`evidence_refs.${key} missing`);
			}
			if (ref.locator_hash !== undefined && typeof ref.locator_hash !== "string") errors.push("locator_hash invalid");
			for (const key of Object.keys(ref)) {
				if (!["source_id", "source_version", "trust_class", "locator_hash"].includes(key)) {
					errors.push(`evidence_refs unexpected ${key}`);
				}
			}
		}
	}
	return errors;
}

export function isUnifiedReceipt(row: UnifiedMemoryReceipt): boolean {
	return row.schema === UNIFIED_RECEIPT_SCHEMA && row.harness === "omp";
}
