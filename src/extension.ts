/**
 * Cognitive State Compiler — OMP extension (P0 shadow + P1 guarded canary).
 *
 * Modes: off | shadow (default) | canary
 * Canary requires explicit opt-in (config/env). Never default.
 *
 * In canary mode only, `context` may return `{ messages }` (virtual list).
 * That replaces model-visible context without mutating canonical session history.
 * Native context is preserved in-memory for a single typed fallback retry.
 *
 * Load: symlink to ~/.omp/agent/extensions/ or project .omp/extensions/
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { LocalSpillStore, wrapRlmStore } from "./rlm-adapter.ts";
import { compileCognitiveState, type FixtureMessage } from "./compiler.ts";
import { createToolReceipt } from "./receipts.ts";
import { ShadowEconomicsSink } from "./tokenomics-shadow.ts";
import type { CognitiveStatePacket, ToolReceiptV1 } from "./schema.ts";
import { resolveConfig, effectiveMode, type CognitiveStateConfig } from "./mode.ts";
import {
	createCanaryHost,
	decideCanaryContext,
	resolveFallback,
	type CanaryCompileHost,
	type CanaryContextDecision,
} from "./canary-runtime.ts";
import type { ProviderContextMessage } from "./provider-messages.ts";

export interface ShadowCompilerState {
	packets: CognitiveStatePacket[];
	receipts: ToolReceiptV1[];
	economics: ShadowEconomicsSink;
	last_compile_ms: number;
	root_compile_count: number;
	canary_flips: number;
	fallback_count: number;
	config: CognitiveStateConfig;
	host?: CanaryCompileHost;
	/** Preserved native context for active canary turn (not session history). */
	pending?: {
		decision: CanaryContextDecision;
		native: FixtureMessage[];
	};
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (part && typeof part === "object" && "text" in part) {
					return String((part as { text: unknown }).text ?? "");
				}
				return JSON.stringify(part);
			})
			.join("\n");
	}
	if (content == null) return "";
	return JSON.stringify(content);
}

export function createShadowCompilerState(
	partial?: Partial<CognitiveStateConfig> & { env?: Record<string, string | undefined> },
): ShadowCompilerState {
	return {
		packets: [],
		receipts: [],
		economics: new ShadowEconomicsSink(),
		last_compile_ms: 0,
		root_compile_count: 0,
		canary_flips: 0,
		fallback_count: 0,
		config: resolveConfig(partial),
	};
}

export default function cognitiveStateShadowExtension(pi: ExtensionAPI): void {
	const state = createShadowCompilerState();
	let spill = new LocalSpillStore();
	let latestUser = "";
	let turn = 0;
	let host: CanaryCompileHost = createCanaryHost({ store: spill, ...state.config });

	(pi as unknown as { _cognitiveStateShadow?: ShadowCompilerState })._cognitiveStateShadow = state;

	const rebindHost = () => {
		host = createCanaryHost({ store: spill, ...state.config });
		state.host = host;
	};
	rebindHost();

	pi.on("session_start", async (_event, ctx) => {
		const hostCtx = ctx as unknown as {
			rlmStore?: Parameters<typeof wrapRlmStore>[0];
			sessionId?: string;
			settings?: { get?: (path: string) => unknown };
		};
		if (hostCtx.rlmStore) {
			spill = wrapRlmStore(hostCtx.rlmStore) as unknown as LocalSpillStore;
		} else {
			spill = new LocalSpillStore();
		}
		const settingsMode = hostCtx.settings?.get?.("cognitiveState.mode");
		const settingsOptIn = hostCtx.settings?.get?.("cognitiveState.canaryOptIn");
		state.config = resolveConfig({
			mode: settingsMode as never,
			canary_opt_in: settingsOptIn === true || settingsOptIn === "true",
			env: process.env,
		});
		rebindHost();
		void hostCtx.sessionId;
	});

	pi.on("tool_result", async (event) => {
		const ev = event as {
			toolName?: string;
			tool_name?: string;
			toolCallId?: string;
			tool_call_id?: string;
			isError?: boolean;
			is_error?: boolean;
			content?: unknown;
			result?: unknown;
			output?: unknown;
		};
		const tool = ev.toolName ?? ev.tool_name ?? "unknown";
		const tool_call_id = ev.toolCallId ?? ev.tool_call_id ?? `tool-${state.receipts.length + 1}`;
		const is_error = Boolean(ev.isError ?? ev.is_error);
		const output = messageContentToText(ev.content ?? ev.result ?? ev.output ?? "");
		const receipt = createToolReceipt(spill, {
			tool,
			tool_call_id,
			is_error,
			output,
			turn,
			parent_user_excerpt: latestUser.slice(0, 240),
			kind: "tool_output",
		});
		state.receipts.push(receipt);
		return undefined;
	});

	pi.on("context", async (event) => {
		if (effectiveMode(state.config) === "off") return undefined;
		// Pick up runtime config mutations / settings without requiring reload.
		host.config = state.config;
		host.store = spill;

		const messages = (event as { messages?: unknown[] }).messages ?? [];
		const fixtureMessages: FixtureMessage[] = messages.map((m) => {
			const msg = m as {
				role?: string;
				content?: unknown;
				toolName?: string;
				tool_name?: string;
				toolCallId?: string;
				tool_call_id?: string;
				isError?: boolean;
			};
			const role = (msg.role ?? "assistant") as FixtureMessage["role"];
			if (role === "user") {
				latestUser = messageContentToText(msg.content);
				turn += 1;
			}
			const normalizedRole =
				role === "toolResult" || role === "tool_result" ? "tool" : role;
			return {
				role: normalizedRole as FixtureMessage["role"],
				content: messageContentToText(msg.content),
				tool_name: msg.toolName ?? msg.tool_name,
				tool_call_id: msg.toolCallId ?? msg.tool_call_id,
				is_error: msg.isError,
			};
		});

		const decision = decideCanaryContext(host, fixtureMessages, {
			user_turn_id: `turn-${turn}`,
			receipts: state.receipts,
		});

		state.packets.push(decision.compile.packet);
		state.last_compile_ms = decision.compile.packet.diagnostics.compile_ms;
		state.root_compile_count += 1;
		for (const ev of host.events.splice(0)) state.economics.emitCanary(ev);

		if (!decision.canary_active || !decision.messages) {
			// shadow / blocked / preflight deny — provider keeps native
			return undefined;
		}

		state.canary_flips += 1;
		state.pending = { decision, native: decision.native_preserve };
		// Return virtual messages — model-visible only; canonical history untouched.
		return { messages: decision.messages as never };
	});

	pi.on("before_provider_request", async () => undefined);

	/**
	 * Extensions cannot always observe provider completion.
	 * Expose an explicit operator/API hook for fallback resolution after a turn.
	 */
	(pi as unknown as { _cognitiveStateResolveFallback?: typeof resolvePendingFallback })._cognitiveStateResolveFallback =
		resolvePendingFallback;

	function resolvePendingFallback(outcome: {
		assistant_text?: string;
		verified: boolean;
		verifier_failed?: boolean;
		native_verifier_passed?: boolean;
		tool_calls?: number;
		repeated_known_state_requests?: number;
		manual_fallback?: boolean;
	}): { fallback: boolean; messages?: ProviderContextMessage[]; reason?: string } {
		if (!state.pending) return { fallback: false };
		const result = resolveFallback(host, state.pending.decision, outcome);
		for (const ev of host.events.splice(0)) state.economics.emitCanary(ev);
		if (result.fallback) state.fallback_count += 1;
		state.pending = undefined;
		return {
			fallback: result.fallback,
			messages: result.messages,
			reason: result.reason,
		};
	}
}

export { compileCognitiveState, answerReconstruction, RECONSTRUCTION_QUESTIONS } from "./compiler.ts";
export { createToolReceipt, extractFacts } from "./receipts.ts";
export { classifyVisibility, mayExternalizeRaw } from "./visibility.ts";
export { LocalSpillStore, formatEvidenceSource, parseEvidenceSource } from "./rlm-adapter.ts";
export { resolveConfig, effectiveMode, parseMode } from "./mode.ts";
export { decideCanaryContext, resolveFallback, createCanaryHost } from "./canary-runtime.ts";
export { diagnoseContextFailure, preflightVirtualContext } from "./diagnostics.ts";
export { gateCanaryTask, classifyTask } from "./task-gate.ts";
export { FallbackLedger } from "./fallback.ts";
export type * from "./schema.ts";
export type { CognitiveStateMode, ContextMode, CognitiveStateConfig } from "./mode.ts";
export type { FallbackReason } from "./fallback.ts";
