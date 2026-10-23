import { createHash } from "node:crypto";
import type { EvidenceRef } from "./types.ts";
import { UNIFIED_RECEIPT_SCHEMA } from "./types.ts";
import type { UnifiedEvidenceRef, UnifiedMemoryReceipt } from "./types.ts";

const SHA_RE = /^[0-9a-f]{7,40}$/;

export function locatorHash(locator: string): string {
	return createHash("sha256").update(locator).digest("hex");
}

/** Keep session identifiers and locators out of shareable cross-harness receipts. */
export function toEvidenceRef(ref: EvidenceRef): UnifiedEvidenceRef {
	return {
		source_id: ref.source_id.startsWith("agentsview:")
			? `agentsview:sha256:${locatorHash(ref.source_id)}`
			: ref.source_id,
		source_version: ref.source_version,
		trust_class: ref.trust_class,
		locator_hash: locatorHash(ref.locator),
	};
}

export function assertShaRevision(revision: string): string {
	const normalized = revision.toLowerCase();
	if (!SHA_RE.test(normalized)) {
		throw new Error(`harness_revision must be a git SHA, got ${revision}`);
	}
	return normalized;
}

/** The JSON Schema keywords used by z0evals@8341084's pinned receipt schema. */
interface SchemaProperty {
	type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
	const?: string;
	enum?: string[];
	pattern?: string;
	minimum?: number;
	required?: string[];
	properties?: Record<string, SchemaProperty>;
	additionalProperties?: boolean;
	items?: SchemaProperty;
}

interface SchemaDoc {
	required?: string[];
	properties?: Record<string, unknown>;
}

function validateProperty(value: unknown, spec: SchemaProperty, path: string, errors: string[]): void {
	if (spec.const !== undefined && value !== spec.const) errors.push(`${path}: const mismatch`);
	if (spec.enum && !spec.enum.includes(value as string)) errors.push(`${path}: not in enum`);

	if (spec.type === "object") {
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			errors.push(`${path}: expected object`);
			return;
		}
		const fields = value as Record<string, unknown>;
		for (const required of spec.required ?? []) {
			if (!Object.hasOwn(fields, required)) errors.push(`${path}: missing ${required}`);
		}
		for (const [key, field] of Object.entries(fields)) {
			const rule = spec.properties?.[key];
			if (rule) validateProperty(field, rule, `${path}.${key}`, errors);
			else if (spec.additionalProperties === false) errors.push(`${path}: unexpected ${key}`);
		}
		return;
	}

	if (spec.type === "array") {
		if (!Array.isArray(value)) {
			errors.push(`${path}: expected array`);
			return;
		}
		if (spec.items) {
			for (const [index, item] of value.entries()) validateProperty(item, spec.items, `${path}[${index}]`, errors);
		}
		return;
	}

	if (spec.type === "string") {
		if (typeof value !== "string") {
			errors.push(`${path}: expected string`);
			return;
		}
		if (spec.pattern && !new RegExp(spec.pattern).test(value)) errors.push(`${path}: pattern mismatch`);
		return;
	}
	if (spec.type === "boolean" && typeof value !== "boolean") errors.push(`${path}: expected boolean`);
	if (spec.type === "number" || spec.type === "integer") {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			errors.push(`${path}: expected finite number`);
			return;
		}
		if (spec.type === "integer" && !Number.isSafeInteger(value)) errors.push(`${path}: expected integer`);
		if (spec.minimum !== undefined && value < spec.minimum) errors.push(`${path}: below minimum`);
	}
}

/** Validate every keyword used by the pinned z0eval schema, including optional fields and nested evidence. */
export function validateUnifiedReceipt(row: unknown, schema: SchemaDoc): string[] {
	const errors: string[] = [];
	validateProperty(row, { type: "object", required: schema.required, properties: schema.properties as Record<string, SchemaProperty>, additionalProperties: false }, "receipt", errors);
	return errors;
}

export function isUnifiedReceipt(row: UnifiedMemoryReceipt): boolean {
	return row.schema === UNIFIED_RECEIPT_SCHEMA && row.harness === "omp";
}
