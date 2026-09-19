import { describe, expect, test } from "bun:test";
import { predictLane, extractFeatures, shadowDecision } from "../src/shadow-router.ts";

describe("shadow router", () => {
	test("research-heavy read-only → AGY_RESEARCH", () => {
		const f = extractFeatures("research why the verifier fails under load");
		expect(predictLane(f).lane).toBe("AGY_RESEARCH");
	});

	test("implement writes → AGY_IMPLEMENT", () => {
		const f = extractFeatures("implement a fix and run bun test");
		expect(predictLane(f).lane).toBe("AGY_IMPLEMENT");
	});

	test("destructive stays OMP_ROOT", () => {
		const f = extractFeatures("force push to prod and deploy");
		expect(predictLane(f).lane).toBe("OMP_ROOT");
	});

	test("shadow_only true unless auto", () => {
		const d = shadowDecision("implement foo", "AGY_IMPLEMENT", "shadow-auto");
		expect(d.shadow_only).toBe(true);
		expect(d.selected).toBe("AGY_IMPLEMENT");
		expect(d.predicted).toBeTruthy();
	});
});
