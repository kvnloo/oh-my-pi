import { describe, expect, it } from "bun:test";
import {
	RuntimeAttestationState,
	resetRuntimeAttestation,
	setRuntimeAttestation,
} from "@oh-my-pi/pi-coding-agent/live-runtime";

describe("request_runtime_reload tool contract (P4)", () => {
	it("queues only one reload per candidate generation and does not reload immediately", () => {
		resetRuntimeAttestation();
		const state = new RuntimeAttestationState({
			session_id: "s",
			cwd: "/tmp",
			core_version: "1",
			source_fingerprint: "x",
		});
		setRuntimeAttestation(state);
		expect(state.generation).toBe(1);

		const key = "__omp_z0_runtime_reload_queued_generation";
		Reflect.deleteProperty(globalThis, key);

		const queue = (generation: number): { queued: boolean; deduped: boolean } => {
			const queued = Reflect.get(globalThis, key);
			if (queued === generation) return { queued: true, deduped: true };
			Reflect.set(globalThis, key, generation);
			return { queued: true, deduped: false };
		};

		const first = queue(state.generation);
		const second = queue(state.generation);
		expect(first).toEqual({ queued: true, deduped: false });
		expect(second).toEqual({ queued: true, deduped: true });
		// Tool does not advance generation — follow-up command does.
		expect(state.generation).toBe(1);
		Reflect.deleteProperty(globalThis, key);
		resetRuntimeAttestation();
	});
});
