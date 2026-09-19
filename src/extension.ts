/**
 * AGY front-door executor extension for OMP.
 *
 * CRITICAL: uses `input` → `{ handled: true }` so the normal OMP/Cursor
 * provider turn NEVER starts for explicitly routed AGY prompts.
 *
 * Explicit UX:
 *   /agy research <prompt>
 *   /agy implement <prompt>
 *   agy:r <prompt>
 *   agy:i <prompt>
 *
 * executorMode: manual | shadow-auto | auto
 * P0 stops at manual + shadow-auto (no Jev authority).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { parseAgyRoute } from "./parse-route.ts";
import { AgyDriver } from "./driver.ts";
import { shadowDecision } from "./shadow-router.ts";
import { TokenomicsSink, emitResearchEvent, emitImplementEvent, emitRouteEvent, emitPressureEvent } from "./tokenomics.ts";
import type { ExecutorMode, ExecutorLane, ResearchReceipt, WorkReceipt } from "./types.ts";

export interface AgyExecutorState {
	mode: ExecutorMode;
	driver: AgyDriver;
	tokenomics: TokenomicsSink;
	cursor_calls_avoided: number;
	last_research?: ResearchReceipt;
	last_implement?: WorkReceipt;
	shadow_predictions: Array<ReturnType<typeof shadowDecision>>;
	omp_provider_requests_intercepted: number;
}

function resolveMode(env: NodeJS.ProcessEnv = process.env): ExecutorMode {
	const m = String(env.OMP_AGY_EXECUTOR_MODE ?? "manual").toLowerCase();
	if (m === "shadow-auto" || m === "auto" || m === "manual") return m;
	return "manual";
}

export function createState(): AgyExecutorState {
	return {
		mode: resolveMode(),
		driver: new AgyDriver({
			agy_bin: process.env.AGY_BIN ?? "agy",
			prefer_warm: process.env.OMP_AGY_WARM !== "0",
		}),
		tokenomics: new TokenomicsSink(),
		cursor_calls_avoided: 0,
		shadow_predictions: [],
		omp_provider_requests_intercepted: 0,
	};
}

async function runRouted(
	state: AgyExecutorState,
	lane: "AGY_RESEARCH" | "AGY_IMPLEMENT",
	prompt: string,
	ctx: {
		sendMessage?: (msg: any, opts?: any) => void;
		appendEntry?: (type: string, data?: unknown) => void;
		ui?: { notify?: (msg: string, level?: string) => void };
	},
): Promise<void> {
	const pressure = {
		...state.driver.pool.snapshot(),
		recent_429_or_rate_limit: Number(process.env.OMP_RECENT_429 ?? 0),
		omp_active_sessions: Number(process.env.OMP_ACTIVE_SESSIONS ?? 1),
		ts: Date.now(),
	};
	state.tokenomics.push(emitPressureEvent(pressure));

	const route = shadowDecision(prompt, lane, state.mode, pressure);
	state.shadow_predictions.push(route);
	state.tokenomics.push(emitRouteEvent(route));

	ctx.ui?.notify?.(`agy:${lane === "AGY_RESEARCH" ? "research" : "implement"} (Cursor bypassed)`, "info");
	ctx.appendEntry?.("z0.agy.route", route);

	if (lane === "AGY_RESEARCH") {
		const receipt = await state.driver.research(prompt);
		state.last_research = receipt;
		state.cursor_calls_avoided += receipt.cursor_calls_avoided;
		state.omp_provider_requests_intercepted += 1;
		state.tokenomics.push(emitResearchEvent(receipt, route));
		ctx.appendEntry?.("z0.agy.research_receipt", receipt);
		ctx.sendMessage?.(
			{
				customType: "z0.agy.research_receipt",
				content: formatResearchMarkdown(receipt, route),
				display: true,
				details: receipt,
			},
			{ triggerTurn: false },
		);
		return;
	}

	const receipt = await state.driver.implement(prompt);
	state.last_implement = receipt;
	state.cursor_calls_avoided += receipt.cursor_calls_avoided;
	state.omp_provider_requests_intercepted += 1;
	state.tokenomics.push(emitImplementEvent(receipt, route));
	ctx.appendEntry?.("z0.agy.work_receipt", receipt);
	ctx.sendMessage?.(
		{
			customType: "z0.agy.work_receipt",
			content: formatWorkMarkdown(receipt, route),
			display: true,
			details: receipt,
		},
		{ triggerTurn: false },
	);
}

function formatResearchMarkdown(r: ResearchReceipt, route: ReturnType<typeof shadowDecision>): string {
	return [
		`## AGY research receipt`,
		`- executor: agy (Cursor provider calls avoided: ${r.cursor_calls_avoided})`,
		`- status: ${r.status}`,
		`- agent: ${r.agent ?? "z0-researcher"}`,
		`- conversation_id: ${r.conversation_id ?? "n/a"}`,
		`- duration_ms: ${r.duration_ms}`,
		`- shadow predicted: ${route.predicted} (conf ${route.confidence})`,
		``,
		`### findings`,
		...r.findings.map((f) => `- ${f}`),
		``,
		`### recommendation`,
		r.recommendation,
	].join("\n");
}

function formatWorkMarkdown(r: WorkReceipt, route: ReturnType<typeof shadowDecision>): string {
	return [
		`## AGY implementation receipt`,
		`- executor: agy (Cursor provider calls avoided: ${r.cursor_calls_avoided})`,
		`- status: ${r.status}`,
		`- worktree: ${r.worktree}`,
		`- base_sha: ${r.base_sha} → head_sha: ${r.head_sha}`,
		`- parent_checkout_untouched: ${r.parent_checkout_untouched}`,
		`- changed_files: ${r.changed_files.join(", ") || "(none)"}`,
		`- verifier: ${r.verifier.ok ? "ok" : "fail"}`,
		`- shadow predicted: ${route.predicted} (conf ${route.confidence})`,
		``,
		`### findings`,
		...r.findings.map((f) => `- ${f}`),
		...(r.blockers.length ? ["", "### blockers", ...r.blockers.map((b) => `- ${b}`)] : []),
	].join("\n");
}

export default function agyExecutorExtension(pi: ExtensionAPI): void {
	const state = createState();
	(pi as unknown as { _agyExecutor?: AgyExecutorState })._agyExecutor = state;

	pi.registerCommand("agy", {
		description: "Route to AGY executor: /agy research|implement <prompt> (bypasses Cursor)",
		handler: async (args, ctx) => {
			const text = `/agy ${args ?? ""}`.trim();
			const route = parseAgyRoute(text);
			if (!route) {
				ctx.ui.notify("Usage: /agy research <prompt> | /agy implement <prompt>", "error");
				return;
			}
			await runRouted(state, route.lane, route.prompt, ctx);
		},
	});

	// Front-door: consume AGY-routed prompts BEFORE provider call.
	pi.on("input", async (event, ctx) => {
		const route = parseAgyRoute(event.text);
		if (!route) {
			// shadow-auto still predicts for ordinary prompts, but does not control
			if (state.mode === "shadow-auto" || state.mode === "auto") {
				const pressure = {
					...state.driver.pool.snapshot(),
					recent_429_or_rate_limit: Number(process.env.OMP_RECENT_429 ?? 0),
					omp_active_sessions: Number(process.env.OMP_ACTIVE_SESSIONS ?? 1),
					ts: Date.now(),
				};
				const pred = shadowDecision(event.text, "OMP_ROOT", state.mode, pressure);
				state.shadow_predictions.push(pred);
				state.tokenomics.push(emitRouteEvent(pred));
				ctx.appendEntry?.("z0.agy.shadow_route", pred);
				// auto authority is intentionally NOT enabled in this slice
			}
			return undefined;
		}

		// Fire AGY work; do not await inside handled return path longer than needed —
		// but we await to ensure receipt lands before UI settles.
		await runRouted(state, route.lane, route.prompt, ctx);
		return { handled: true };
	});

	// Observability only: if somehow a provider request starts after handled input, count it.
	pi.on("before_provider_request", async () => {
		// Explicit AGY routes should never reach here.
		return undefined;
	});
}

export { parseAgyRoute, isAgyFrontDoor } from "./parse-route.ts";
export { AgyDriver } from "./driver.ts";
export { AgyPool } from "./pool.ts";
export { shadowDecision, predictLane, extractFeatures } from "./shadow-router.ts";
export type * from "./types.ts";
