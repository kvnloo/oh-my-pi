#!/usr/bin/env bun
/**
 * Demo: Handsfree window actions via computer.decide() + live Jev.
 *
 * Run from repo root:
 *   set -a && source ~/.omp/.env && set +a
 *   bun scripts/demo-jev-handsfree.ts
 *
 * Does not move the pointer. Prints replayable packets only.
 */
import { TypeSafeJudge } from "@oh-my-pi/pi-ai";
import { decideComputerStep, type ComputerDecisionState } from "../packages/coding-agent/src/computer/decide";

const key = process.env.TYPESAFE_API_KEY?.trim();
if (!key) {
	console.error("TYPESAFE_API_KEY missing — source ~/.omp/.env");
	process.exit(1);
}

const judge = new TypeSafeJudge({ apiKey: key, timeoutMs: 2500 });

const scenarios: Array<{ id: string; state: ComputerDecisionState }> = [
	{
		id: "exact-save",
		state: {
			goal: "click Save",
			app: "handsfree-demo",
			candidates: [
				{ id: "e1", label: "Save", role: "button", source: "ax" },
				{ id: "e2", label: "Cancel", role: "button", source: "ax" },
			],
		},
	},
	{
		id: "jev-enroll",
		state: {
			goal: "confirm this booking",
			app: "handsfree-demo",
			candidates: [
				{ id: "e1", label: "Continue", role: "button", source: "ax" },
				{ id: "e2", label: "Go back", role: "button", source: "ax" },
				{ id: "e3", label: "Learn more", role: "button", source: "ax" },
			],
		},
	},
];

async function run(id: string, state: ComputerDecisionState, useJev: boolean): Promise<void> {
	const started = performance.now();
	const packet = await decideComputerStep({ state, judge, useJev });
	const wallMs = Math.round(performance.now() - started);
	if (!packet) {
		console.log(JSON.stringify({ id, useJev, wallMs, packet: null, note: "fail-open to planner" }));
		return;
	}
	console.log(
		JSON.stringify({
			id,
			useJev,
			wallMs,
			backend: packet.backend,
			action: packet.action,
			target: packet.target,
			confidence: Number(packet.confidence.toFixed(3)),
			latencyMs: Math.round(packet.latencyMs),
			model: packet.model ?? null,
			needsVision: packet.needsVision,
		}),
	);
}

for (const scenario of scenarios) {
	await run(scenario.id, scenario.state, false);
	await run(scenario.id, scenario.state, true);
}
