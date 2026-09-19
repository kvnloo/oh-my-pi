import { describe, expect, test } from "bun:test";
import { effectiveMode, resolveConfig, parseMode } from "../src/mode.ts";
import { classifyTask, gateCanaryTask } from "../src/task-gate.ts";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import { createCanaryHost, decideCanaryContext, resolveFallback } from "../src/canary-runtime.ts";
import { diagnoseContextFailure, preflightVirtualContext } from "../src/diagnostics.ts";
import { compileCognitiveState } from "../src/compiler.ts";
import cognitiveStateShadowExtension from "../src/extension.ts";

describe("mode config", () => {
	test("default is shadow", () => {
		const cfg = resolveConfig({ env: {} });
		expect(cfg.mode).toBe("shadow");
		expect(effectiveMode(cfg)).toBe("shadow");
	});

	test("canary without opt-in degrades to shadow", () => {
		const cfg = resolveConfig({ mode: "canary", canary_opt_in: false, env: {} });
		expect(effectiveMode(cfg)).toBe("shadow");
	});

	test("canary with opt-in activates", () => {
		const cfg = resolveConfig({
			env: { OMP_COGNITIVE_STATE_MODE: "canary", OMP_COGNITIVE_STATE_CANARY_OPT_IN: "1" },
		});
		expect(parseMode("canary")).toBe("canary");
		expect(effectiveMode(cfg)).toBe("canary");
	});
});

describe("task gate", () => {
	test("blocks destructive / credentials / deploy", () => {
		expect(classifyTask({ user_text: "rm -rf /prod" })).toBe("destructive");
		expect(classifyTask({ user_text: "rotate api key in vault" })).toBe("credentials_security");
		expect(classifyTask({ user_text: "deploy release to prod" })).toBe("release_deploy");
	});

	test("allows tests and inspection", () => {
		const cfg = resolveConfig({ mode: "canary", canary_opt_in: true });
		expect(gateCanaryTask(cfg, { user_text: "run bun test for visibility" }).allowed).toBe(true);
		expect(gateCanaryTask(cfg, { user_text: "inspect src layout" }).allowed).toBe(true);
	});
});

describe("canary flip + fallback", () => {
	test("shadow mode does not return messages", () => {
		const store = new LocalSpillStore();
		const host = createCanaryHost({ store, mode: "shadow", canary_opt_in: false });
		const d = decideCanaryContext(host, [
			{ role: "user", content: "Run tests for mode defaults." },
			{ role: "tool", tool_name: "bash", tool_call_id: "t1", content: "ok\n18/18 pass\n" + "z".repeat(2000) },
		], { explicit_task_class: "tests" });
		expect(d.canary_active).toBe(false);
		expect(d.messages).toBeUndefined();
		expect(d.compile.packet.diagnostics.provider_receives).toBe("native");
	});

	test("canary returns virtual messages and preserves native", () => {
		const store = new LocalSpillStore();
		const host = createCanaryHost({ store, mode: "canary", canary_opt_in: true });
		const raw = "18/18 pass\n" + "RAW".repeat(1500);
		const d = decideCanaryContext(host, [
			{ role: "user", content: "Run unit tests for cognitive-state." },
			{ role: "tool", tool_name: "bash", tool_call_id: "t1", content: raw },
		], { explicit_task_class: "tests" });
		expect(d.canary_active).toBe(true);
		expect(d.messages?.length).toBeGreaterThan(0);
		expect(d.native_preserve.find((m) => m.role === "tool")!.content).toBe(raw);
		const virtTool = d.compile.virtual_context.find((m) => m.role === "tool")!;
		expect(virtTool.content.length).toBeLessThan(raw.length / 5);
	});

	test("typed fallback on verifier failure vs native pass", () => {
		const store = new LocalSpillStore();
		const host = createCanaryHost({ store, mode: "canary", canary_opt_in: true });
		const d = decideCanaryContext(host, [
			{ role: "user", content: "Inspect repository layout." },
			{ role: "tool", tool_name: "bash", tool_call_id: "t1", content: "files...\n" + "x".repeat(1000) },
		], { explicit_task_class: "repository_inspection" });
		const fb = resolveFallback(host, d, {
			assistant_text: "done",
			verified: false,
			verifier_failed: true,
			native_verifier_passed: true,
		});
		expect(fb.fallback).toBe(true);
		expect(fb.reason).toBe("VERIFIER_FAILURE");
		expect(fb.ids.fallback_attempt_id).toBeTruthy();
		expect(fb.ids.user_turn_id).toBe(d.ids.user_turn_id);
		expect(fb.ids.causal_trace_id).toBe(d.ids.causal_trace_id);
		expect(fb.messages).toBeTruthy();
	});

	test("extension canary opt-in returns context messages", async () => {
		const handlers = new Map<string, Function[]>();
		const pi = {
			on(event: string, handler: Function) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		cognitiveStateShadowExtension(pi as never);
		const state = (pi as unknown as { _cognitiveStateShadow: { config: { mode: string; canary_opt_in: boolean }; canary_flips: number } })._cognitiveStateShadow;
		state.config.mode = "canary";
		state.config.canary_opt_in = true;
		const result = await handlers.get("context")![0]!({
			type: "context",
			messages: [
				{ role: "user", content: "Run bun test for the canary path." },
				{ role: "tool", toolName: "bash", toolCallId: "1", content: "pass 3/3\n" + "y".repeat(2500) },
			],
		});
		expect(result?.messages).toBeTruthy();
		expect(state.canary_flips).toBe(1);
	});
});

describe("diagnostics", () => {
	test("preflight catches missing handle", () => {
		const store = new LocalSpillStore();
		const compile = compileCognitiveState({
			messages: [
				{ role: "user", content: "tests" },
				{ role: "tool", tool_name: "bash", tool_call_id: "a", content: "ok" },
			],
			store,
		});
		// sabotage store
		store.records.clear();
		const finding = preflightVirtualContext(compile.packet, store, compile.virtual_context);
		expect(finding?.reason).toBe("MISSING_EVIDENCE");
	});

	test("model asking for earlier raw => UNRESOLVED_REFERENCE", () => {
		const store = new LocalSpillStore();
		const compile = compileCognitiveState({
			messages: [
				{ role: "user", content: "debug hang" },
				{ role: "tool", tool_name: "bash", tool_call_id: "a", content: "hang" },
			],
			store,
		});
		const finding = diagnoseContextFailure({
			packet: compile.packet,
			store,
			assistant_text: "Please paste the earlier full raw output; missing context.",
		});
		expect(finding?.reason).toBe("UNRESOLVED_REFERENCE");
	});
});
