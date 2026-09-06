import { describe, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import type { RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";

/**
 * Compile-time regression guard for the `cycle_thinking_level` RPC response.
 *
 * The handler in `rpc-mode.ts` forwards `AgentSession.cycleThinkingLevel()`
 * verbatim via a `success(...)` helper that casts payloads with
 * `as RpcResponse`, so the per-variant `data` shape is never checked against
 * the runtime payload at compile time. `cycleThinkingLevel()` returns
 * `ConfiguredThinkingLevel` ("off" | "auto" | Effort), so the wire variant
 * must accept every one of those values. The assignments below fail to
 * compile under `tsgo` if the variant regresses to the narrower `Effort`
 * set, before any test runner executes.
 */
type CycleThinkingResponse = Extract<RpcResponse, { command: "cycle_thinking_level"; success: true }>;
type CycleThinkingData = CycleThinkingResponse["data"];
type DeclaredLevel = CycleThinkingData extends { level: infer L } | null ? L : never;

// Every value the server can emit must satisfy the declared wire type. "off"
// and "auto" are bare string selectors; the effort rungs are `Effort` enum
// members, so they must be referenced via the enum to typecheck against the
// `ConfiguredThinkingLevel` union.
const offAcceptable: DeclaredLevel = "off";
const autoAcceptable: DeclaredLevel = "auto";
const minimalAcceptable: DeclaredLevel = Effort.Minimal;
const highAcceptable: DeclaredLevel = Effort.High;
const maxAcceptable: DeclaredLevel = Effort.Max;

// The declared type must be exactly `ConfiguredThinkingLevel`: wide enough to
// cover the runtime payload, and no wider.
type IsExact<T, U> = [T extends U ? true : false, U extends T ? true : false] extends [true, true] ? true : false;
const exactContract: IsExact<DeclaredLevel, ConfiguredThinkingLevel> = true;

describe("cycle_thinking_level RPC contract", () => {
	it("declares data.level as ConfiguredThinkingLevel (off | auto | Effort)", () => {
		// Retain the compile-time assertions as live bindings.
		[offAcceptable, autoAcceptable, minimalAcceptable, highAcceptable, maxAcceptable, exactContract];
	});
});
