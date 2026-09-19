/**
 * Shadow CognitiveStatePacket compiler.
 * Builds native_context + virtual_context metrics; provider stays on native.
 */

import {
	COGNITIVE_STATE_SCHEMA,
	type CognitiveStatePacket,
	type DecisionItem,
	type EvidenceRef,
	type KnowledgeItem,
	type ShadowContextEconomics,
	type ToolReceiptV1,
	type VisibilityCounts,
	type WorkItem,
} from "./schema.ts";
import { classifyVisibility, mayExternalizeRaw } from "./visibility.ts";
import { estimateJsonTokens, estimateTokens } from "./tokens.ts";
import { createToolReceipt, type ToolResultInput } from "./receipts.ts";
import type { SpillStore } from "./rlm-adapter.ts";

export interface FixtureMessage {
	role: "user" | "assistant" | "tool" | "system";
	content: string;
	tool_name?: string;
	tool_call_id?: string;
	is_error?: boolean;
	/** Optional explicit visibility hint for fixture authors. */
	visibility_hint?: "LIVE" | "RECEIPT" | "EXTERNAL" | "ARCHIVED";
}

export interface CompileInput {
	messages: FixtureMessage[];
	receipts?: ToolReceiptV1[];
	store: SpillStore;
	session_id?: string;
	repo_worktree?: string;
	plan_generation?: string;
	objective?: string;
	acceptance?: string[];
	invariants?: string[];
	authority?: string;
	phase?: string;
	bottleneck?: string;
	open_commitments?: string[];
	next_action?: string;
	alternatives?: string[];
	/** Auto-spill tool messages lacking receipts. */
	auto_receipt?: boolean;
	/** Annotate packet/economics for canary vs shadow. */
	provider_receives?: "native" | "virtual";
	context_mode?: "native" | "virtual" | "virtual_fallback_native";
	/** Only set measured savings when virtual actually succeeded. */
	measure_token_savings?: boolean;
}

export interface CompileResult {
	packet: CognitiveStatePacket;
	economics: ShadowContextEconomics;
	/** Native messages unchanged (provider path). */
	native_context: FixtureMessage[];
	/**
	 * Virtual message list. In canary mode the extension may return these via `context`.
	 * Tool raw bodies replaced by receipt stubs when safe.
	 */
	virtual_context: FixtureMessage[];
	receipts: ToolReceiptV1[];
}

function emptyCounts(): VisibilityCounts {
	return { LIVE: 0, RECEIPT: 0, EXTERNAL: 0, ARCHIVED: 0 };
}

function latestUser(messages: FixtureMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]!.role === "user") return messages[i]!.content;
	}
	return "";
}

function inferObjective(user: string, explicit?: string): string {
	if (explicit?.trim()) return explicit.trim();
	const line = user.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
	return line.slice(0, 240) || "(unspecified objective)";
}

function inferInvariants(text: string, explicit?: string[]): string[] {
	if (explicit?.length) return explicit;
	const found: string[] = [];
	const patterns = [
		/do not\s+[^\n.]{5,120}/gi,
		/must not\s+[^\n.]{5,120}/gi,
		/never\s+[^\n.]{5,80}/gi,
		/STOP\b[^\n]{0,80}/g,
		/canonical transcript[^\n.]{0,80}/gi,
		/provider (?:still )?receives native[^\n.]{0,40}/gi,
	];
	for (const re of patterns) {
		for (const m of text.matchAll(re)) {
			found.push(m[0].trim().slice(0, 160));
			if (found.length >= 8) return found;
		}
	}
	return found;
}

export function compileCognitiveState(input: CompileInput): CompileResult {
	const t0 = performance.now();
	const messages = input.messages;
	const native_context = messages.map((m) => ({ ...m }));
	const receipts: ToolReceiptV1[] = [...(input.receipts ?? [])];
	const receiptByCall = new Map(receipts.map((r) => [r.tool_call_id, r]));

	if (input.auto_receipt !== false) {
		let turn = 0;
		const parent = latestUser(messages).slice(0, 240);
		for (const m of messages) {
			if (m.role === "user") turn += 1;
			if (m.role !== "tool") continue;
			const id = m.tool_call_id ?? `anon-${receipts.length + 1}`;
			if (receiptByCall.has(id)) continue;
			const tr: ToolResultInput = {
				tool: m.tool_name ?? "unknown",
				tool_call_id: id,
				is_error: m.is_error,
				output: m.content,
				turn,
				parent_user_excerpt: parent,
				kind: "tool_output",
			};
			const receipt = createToolReceipt(input.store, tr);
			receipts.push(receipt);
			receiptByCall.set(id, receipt);
		}
	}

	const userText = latestUser(messages);
	const knowledge: KnowledgeItem[] = [];
	const work: WorkItem[] = [];
	const decisions: DecisionItem[] = [];
	const evidence: EvidenceRef[] = [];
	const counts = emptyCounts();

	for (const r of receipts) {
		evidence.push({
			handle: r.artifact_handle,
			kind: r.kind,
			visibility: r.visibility,
			sha256: r.raw_sha256,
			bytes: r.raw_bytes,
			tool: r.tool,
			status: r.status,
			verifier: r.verifier,
		});
		counts[r.visibility] += 1;

		const unresolved = r.status === "error";
		work.push({
			id: r.tool_call_id,
			summary: `${r.tool}: ${r.facts[0] ?? r.status}`,
			status: unresolved ? "active" : "recently_completed",
			visibility: r.visibility,
			tool: r.tool,
			evidence_handle: r.artifact_handle,
		});

		if (!unresolved && r.facts.length) {
			knowledge.push({
				claim: `${r.tool} → ${r.facts.slice(0, 3).join("; ")}`,
				status: "established",
				visibility: "RECEIPT",
				evidence_handle: r.artifact_handle,
			});
		} else if (unresolved) {
			knowledge.push({
				claim: `${r.tool} FAILED: ${r.facts.slice(0, 2).join("; ") || "error"}`,
				status: "provisional",
				visibility: "LIVE",
				evidence_handle: r.artifact_handle,
			});
		}
	}

	// Dialogue / decisions heuristics from user text
	if (/should we|which|choose|decide/i.test(userText)) {
		decisions.push({
			id: "d-latest",
			question: userText.slice(0, 200),
			status: "unresolved",
			visibility: "LIVE",
		});
		counts.LIVE += 1;
	}

	const virtual_context: FixtureMessage[] = [];
	for (const m of messages) {
		if (m.role === "user") {
			virtual_context.push({ ...m, visibility_hint: "LIVE" });
			counts.LIVE += 1;
			continue;
		}
		if (m.role === "tool") {
			const id = m.tool_call_id ?? "";
			const receipt = receiptByCall.get(id);
			const unresolved = Boolean(m.is_error) || receipt?.status === "error";
			const vis = receipt?.visibility ?? classifyVisibility({
				kind: "tool_result",
				status: m.is_error ? "error" : "ok",
				unresolved,
				has_receipt: Boolean(receipt),
			});
			if (receipt && mayExternalizeRaw(vis, unresolved)) {
				virtual_context.push({
					role: "tool",
					tool_name: m.tool_name,
					tool_call_id: m.tool_call_id,
					is_error: m.is_error,
					visibility_hint: "RECEIPT",
					content: JSON.stringify({
						receipt: "z0.tool_receipt.v1",
						tool: receipt.tool,
						status: receipt.status,
						facts: receipt.facts,
						handle: receipt.artifact_handle,
						sha256: receipt.raw_sha256,
						bytes: receipt.raw_bytes,
						verifier: receipt.verifier,
					}),
				});
			} else {
				virtual_context.push({ ...m, visibility_hint: "LIVE" });
			}
			continue;
		}
		if (m.role === "assistant") {
			virtual_context.push({
				...m,
				content: m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content,
				visibility_hint: "EXTERNAL",
			});
			counts.EXTERNAL += 1;
			continue;
		}
		virtual_context.push({ ...m, visibility_hint: "EXTERNAL" });
	}

	const packetBody = {
		intent: {
			objective: inferObjective(userText, input.objective),
			acceptance: input.acceptance ?? [],
			invariants: inferInvariants(userText, input.invariants),
			authority: input.authority ?? "shadow-compiler",
			budgets: {
				max_live_items: 32,
				max_receipt_items: 64,
				max_evidence_handles: 32,
			},
		},
		state: {
			current_phase: input.phase ?? "shadow-compile",
			current_bottleneck: input.bottleneck ?? inferBottleneck(work),
			repo_worktree: input.repo_worktree ?? ".",
			plan_generation: input.plan_generation,
		},
		knowledge,
		work,
		decisions,
		evidence: evidence.slice(0, 32),
		dialogue: {
			latest_user_input: userText,
			open_commitments: input.open_commitments ?? [],
		},
		next: {
			recommended: input.next_action ?? inferNext(work, userText),
			alternatives: input.alternatives ?? [],
		},
	};

	const native_estimated_tokens = estimateTokens(
		messages.map((m) => `${m.role}:${m.content}`).join("\n"),
	);
	const virtual_estimated_tokens = estimateJsonTokens(packetBody) + estimateTokens(
		virtual_context.map((m) => `${m.role}:${m.content}`).join("\n"),
	);

	const live_tokens = estimateTokens(
		virtual_context.filter((m) => m.visibility_hint === "LIVE").map((m) => m.content).join("\n"),
	);
	const receipt_tokens = estimateJsonTokens(receipts);
	const evidence_tokens = estimateJsonTokens(evidence);
	const externalized_bytes = receipts.reduce((a, r) => a + r.raw_bytes, 0);

	const missing_required_evidence: string[] = [];
	for (const w of work) {
		if (w.status === "active" && !w.evidence_handle) {
			missing_required_evidence.push(w.id);
		}
	}

	const compile_ms = Math.round((performance.now() - t0) * 1000) / 1000;
	const provider_receives = input.provider_receives ?? "native";
	const context_mode = input.context_mode ?? (provider_receives === "virtual" ? "virtual" : "native");
	const shadow_only = provider_receives !== "virtual";
	const measured_tokens_avoided =
		input.measure_token_savings && provider_receives === "virtual"
			? Math.max(0, native_estimated_tokens - virtual_estimated_tokens)
			: 0;

	const packet: CognitiveStatePacket = {
		schema: COGNITIVE_STATE_SCHEMA,
		compiled_at: Date.now(),
		session_id: input.session_id,
		...packetBody,
		visibility_counts: counts,
		diagnostics: {
			native_estimated_tokens,
			virtual_estimated_tokens,
			live_tokens,
			receipt_tokens,
			evidence_tokens,
			externalized_bytes,
			compile_ms,
			missing_required_evidence,
			shadow_only,
			provider_receives,
			context_mode,
		},
	};

	const economics: ShadowContextEconomics = {
		native_context_tokens: native_estimated_tokens,
		virtual_context_tokens: virtual_estimated_tokens,
		compile_ms,
		receipt_tokens,
		live_tokens,
		evidence_tokens,
		externalized_bytes,
		measured_tokens_avoided,
		live_count: counts.LIVE,
		receipt_count: counts.RECEIPT,
		external_count: counts.EXTERNAL,
		archived_count: counts.ARCHIVED,
		selected_evidence_handles: evidence.map((e) => e.handle),
		missing_required_evidence,
		shadow_only,
		context_mode,
	};

	return { packet, economics, native_context, virtual_context, receipts };
}

function inferBottleneck(work: WorkItem[]): string {
	const active = work.find((w) => w.status === "active");
	if (active) return `unresolved:${active.tool ?? active.id}`;
	const pending = work.find((w) => w.status === "pending");
	if (pending) return `pending:${pending.id}`;
	return "none";
}

function inferNext(work: WorkItem[], user: string): string {
	const fail = work.find((w) => w.status === "active");
	if (fail) return `investigate failing tool ${fail.tool ?? fail.id}`;
	if (/STOP|report|accept/i.test(user)) return "emit acceptance report";
	return "continue current objective";
}

/** Reconstruction probe questions for acceptance. */
export const RECONSTRUCTION_QUESTIONS = [
	"what are we trying to do?",
	"what is already proven?",
	"what is still pending?",
	"what invariant must not be violated?",
	"what result just arrived?",
	"what is the next action?",
] as const;

export function answerReconstruction(packet: CognitiveStatePacket): Record<(typeof RECONSTRUCTION_QUESTIONS)[number], string> {
	const proven = packet.knowledge.filter((k) => k.status === "established").map((k) => k.claim);
	const pending = packet.work.filter((w) => w.status === "active" || w.status === "pending");
	const latest = packet.work.filter((w) => w.status === "recently_completed").slice(-1)[0];
	return {
		"what are we trying to do?": packet.intent.objective,
		"what is already proven?": proven.join(" | ") || "(none established)",
		"what is still pending?": pending.map((w) => w.summary).join(" | ") || "(none pending)",
		"what invariant must not be violated?": packet.intent.invariants.join(" | ") || "(none listed)",
		"what result just arrived?": latest?.summary ?? "(no recent completion)",
		"what is the next action?": packet.next.recommended,
	};
}
