/**
 * ACTIVE_WITH_FALLBACK canary path (opt-in only).
 * Virtual attempt first; typed fallback to preserved native context once.
 */

import { compileCognitiveState, type CompileResult, type FixtureMessage } from "./compiler.ts";
import type { SpillStore } from "./rlm-adapter.ts";
import {
	attachFallbackAttempt,
	FallbackLedger,
	startTurnIds,
	type CanaryTurnRecord,
	type FallbackReason,
	type TurnAttemptIds,
} from "./fallback.ts";
import { diagnoseContextFailure, preflightVirtualContext } from "./diagnostics.ts";
import { gateCanaryTask, type TaskClass } from "./task-gate.ts";
import {
	effectiveMode,
	isCanaryActive,
	resolveConfig,
	type CognitiveStateConfig,
	type ContextMode,
} from "./mode.ts";
import { fixtureToProviderMessages, injectPacketCustomMessage, type ProviderContextMessage } from "./provider-messages.ts";
import { makeCanaryEconomicsEvent, type CanaryEconomicsEvent } from "./tokenomics-shadow.ts";

export interface CanaryCompileHost {
	store: SpillStore;
	config: CognitiveStateConfig;
	ledger: FallbackLedger;
	events: CanaryEconomicsEvent[];
}

export interface CanaryContextDecision {
	/** What to return from context hook (undefined = leave native). */
	messages?: ProviderContextMessage[];
	compile: CompileResult;
	ids: TurnAttemptIds;
	context_mode: ContextMode;
	task_class: TaskClass;
	/** Native snapshot preserved for fallback (not written to session). */
	native_preserve: FixtureMessage[];
	canary_active: boolean;
	blocked_reason?: string;
	preflight_fallback_reason?: FallbackReason;
}

export function createCanaryHost(partial?: Partial<CognitiveStateConfig> & {
	env?: Record<string, string | undefined>;
	store: SpillStore;
}): CanaryCompileHost {
	return {
		store: partial!.store,
		config: resolveConfig(partial),
		ledger: new FallbackLedger(),
		events: [],
	};
}

export function decideCanaryContext(
	host: CanaryCompileHost,
	messages: FixtureMessage[],
	opts?: {
		user_turn_id?: string;
		receipts?: CompileResult["receipts"];
		objective?: string;
		invariants?: string[];
		explicit_task_class?: TaskClass;
	},
): CanaryContextDecision {
	const ids = startTurnIds(opts?.user_turn_id);
	const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
	const unresolved = messages.some((m) => m.role === "tool" && m.is_error);
	const unresolvedBytes = messages
		.filter((m) => m.role === "tool" && m.is_error)
		.reduce((a, m) => a + Buffer.byteLength(m.content, "utf8"), 0);

	const gate = gateCanaryTask(host.config, {
		user_text: user,
		has_unresolved_error: unresolved,
		unresolved_raw_bytes: unresolvedBytes,
		explicit_class: opts?.explicit_task_class,
	});

	const canary = isCanaryActive(host.config) && gate.allowed;
	const provider_receives = canary ? "virtual" : "native";
	const compile = compileCognitiveState({
		messages,
		store: host.store,
		receipts: opts?.receipts,
		objective: opts?.objective,
		invariants: opts?.invariants,
		auto_receipt: true,
		provider_receives,
		context_mode: canary ? "virtual" : "native",
		measure_token_savings: false, // only after verified success
	});

	if (!canary) {
		const mode = effectiveMode(host.config);
		const ev = makeCanaryEconomicsEvent(compile.economics, {
			context_mode: "native",
			mode,
			task_class: gate.task_class,
			attempt: "none",
		});
		host.events.push(ev);
		return {
			compile,
			ids,
			context_mode: "native",
			task_class: gate.task_class,
			native_preserve: compile.native_context,
			canary_active: false,
			blocked_reason: !isCanaryActive(host.config)
				? `mode=${mode}`
				: gate.reason,
		};
	}

	const pre = preflightVirtualContext(compile.packet, host.store, compile.virtual_context);
	if (pre) {
		// Do not send virtual; stay native (counts as preflight deny, not fallback retry)
		const economics = { ...compile.economics, context_mode: "native" as const, measured_tokens_avoided: 0, shadow_only: true };
		host.events.push(
			makeCanaryEconomicsEvent(economics, {
				context_mode: "native",
				mode: "canary",
				task_class: gate.task_class,
				attempt: "preflight_deny",
				fallback_reason: pre.reason,
			}),
		);
		return {
			compile: { ...compile, economics, packet: { ...compile.packet, diagnostics: { ...compile.packet.diagnostics, provider_receives: "native", shadow_only: true, context_mode: "native" } } },
			ids,
			context_mode: "native",
			task_class: gate.task_class,
			native_preserve: compile.native_context,
			canary_active: false,
			preflight_fallback_reason: pre.reason,
			blocked_reason: pre.detail,
		};
	}

	const providerMsgs = injectPacketCustomMessage(
		fixtureToProviderMessages(compile.virtual_context),
		JSON.stringify({
			schema: compile.packet.schema,
			intent: compile.packet.intent,
			state: compile.packet.state,
			knowledge: compile.packet.knowledge,
			work: compile.packet.work,
			decisions: compile.packet.decisions,
			evidence: compile.packet.evidence,
			dialogue: compile.packet.dialogue,
			next: compile.packet.next,
		}),
	);

	host.events.push(
		makeCanaryEconomicsEvent(compile.economics, {
			context_mode: "virtual",
			mode: "canary",
			task_class: gate.task_class,
			attempt: "virtual",
			virtual_attempt_id: ids.virtual_attempt_id,
			user_turn_id: ids.user_turn_id,
			causal_trace_id: ids.causal_trace_id,
		}),
	);

	return {
		messages: providerMsgs,
		compile,
		ids,
		context_mode: "virtual",
		task_class: gate.task_class,
		native_preserve: compile.native_context,
		canary_active: true,
	};
}

export interface VirtualAttemptOutcome {
	assistant_text?: string;
	verified: boolean;
	verifier_failed?: boolean;
	native_verifier_passed?: boolean;
	tool_calls?: number;
	repeated_known_state_requests?: number;
	manual_fallback?: boolean;
}

/**
 * After a virtual provider attempt, decide whether to fallback once.
 * Returns native provider messages if fallback needed.
 */
export function resolveFallback(
	host: CanaryCompileHost,
	decision: CanaryContextDecision,
	outcome: VirtualAttemptOutcome,
): {
	fallback: boolean;
	reason?: FallbackReason;
	messages?: ProviderContextMessage[];
	ids: TurnAttemptIds;
	record: CanaryTurnRecord;
} {
	if (!decision.canary_active) {
		const record: CanaryTurnRecord = {
			ids: decision.ids,
			context_mode: "virtual",
			virtual_verified: outcome.verified,
			native_tokens: decision.compile.economics.native_context_tokens,
			virtual_tokens: decision.compile.economics.virtual_context_tokens,
			compile_ms: decision.compile.economics.compile_ms,
			task_class: decision.task_class,
		};
		return { fallback: false, ids: decision.ids, record };
	}

	const finding = diagnoseContextFailure({
		packet: decision.compile.packet,
		store: host.store,
		assistant_text: outcome.assistant_text,
		verifier_failed: outcome.verifier_failed ?? !outcome.verified,
		native_verifier_passed: outcome.native_verifier_passed,
		tool_calls: outcome.tool_calls,
		repeated_known_state_requests: outcome.repeated_known_state_requests,
		manual_fallback: outcome.manual_fallback,
	});

	// UNKNOWN / no finding => do not auto-fallback (ambiguous attribution).
	if (!finding || finding.reason === "UNKNOWN") {
		const saved = Math.max(
			0,
			decision.compile.economics.native_context_tokens - decision.compile.economics.virtual_context_tokens,
		);
		const economics = {
			...decision.compile.economics,
			measured_tokens_avoided: outcome.verified ? saved : 0,
			context_mode: "virtual" as const,
			shadow_only: false,
		};
		host.events.push(
			makeCanaryEconomicsEvent(economics, {
				context_mode: "virtual",
				mode: "canary",
				task_class: decision.task_class,
				attempt: outcome.verified ? "virtual_success" : "virtual_unverified",
				virtual_attempt_id: decision.ids.virtual_attempt_id,
				user_turn_id: decision.ids.user_turn_id,
				causal_trace_id: decision.ids.causal_trace_id,
				fallback_reason: finding?.reason === "UNKNOWN" ? "UNKNOWN" : undefined,
			}),
		);
		const record: CanaryTurnRecord = {
			ids: decision.ids,
			context_mode: "virtual",
			fallback_reason: finding?.reason === "UNKNOWN" ? "UNKNOWN" : undefined,
			virtual_verified: outcome.verified,
			native_tokens: economics.native_context_tokens,
			virtual_tokens: economics.virtual_context_tokens,
			compile_ms: economics.compile_ms,
			task_class: decision.task_class,
		};
		host.ledger.record(record);
		return { fallback: false, ids: decision.ids, record };
	}

	// Fallback once with preserved native context
	const ids = attachFallbackAttempt(decision.ids);
	const messages = fixtureToProviderMessages(decision.native_preserve);
	host.events.push(
		makeCanaryEconomicsEvent(
			{ ...decision.compile.economics, measured_tokens_avoided: 0, context_mode: "virtual_fallback_native", shadow_only: false },
			{
				context_mode: "virtual_fallback_native",
				mode: "canary",
				task_class: decision.task_class,
				attempt: "fallback",
				fallback_reason: finding.reason,
				virtual_attempt_id: ids.virtual_attempt_id,
				fallback_attempt_id: ids.fallback_attempt_id,
				user_turn_id: ids.user_turn_id,
				causal_trace_id: ids.causal_trace_id,
			},
		),
	);
	const record: CanaryTurnRecord = {
		ids,
		context_mode: "virtual_fallback_native",
		fallback_reason: finding.reason,
		virtual_verified: false,
		native_tokens: decision.compile.economics.native_context_tokens,
		virtual_tokens: decision.compile.economics.virtual_context_tokens,
		fallback_tokens: decision.compile.economics.native_context_tokens,
		compile_ms: decision.compile.economics.compile_ms,
		task_class: decision.task_class,
	};
	host.ledger.record(record);
	return { fallback: true, reason: finding.reason, messages, ids, record };
}
