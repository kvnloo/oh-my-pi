import { describe, expect, test } from "bun:test";
import { applyGlobalModelsDevFallback } from "../scripts/generate-models";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

function responsesSpec(overrides: Partial<ModelSpec<"openai-responses">>): ModelSpec<"openai-responses"> {
	return {
		id: "muse-spark-1.3-contributor",
		name: "Muse Spark 1.3 (C)",
		api: "openai-responses",
		provider: "muse-code",
		baseUrl: "https://api.meta.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.002, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		...overrides,
	};
}

// A same-id stencil.so (models.dev) reference row carried by a gateway provider.
// `applyGlobalModelsDevFallback` keys the global reference map by `model.id`
// (not `${provider}/${id}`), so this row's display name / int / tps would
// overwrite any same-id seed row that is NOT on the skip predicate.
const stencilReference = responsesSpec({
	name: "Muse Spark 1.3 Contributor",
	provider: "opencode-go",
	int: 53,
	tps: 190.1,
});

describe("applyGlobalModelsDevFallback skip predicate", () => {
	test("muse-code seed row is skipped (curated (C) name preserved, no int/tps overlay)", () => {
		const seed = responsesSpec({ provider: "muse-code", name: "Muse Spark 1.3 (C)" });
		const [out] = applyGlobalModelsDevFallback([seed], [stencilReference]);
		expect(out.name).toBe("Muse Spark 1.3 (C)");
		expect(out.int).toBeUndefined();
		expect(out.tps).toBeUndefined();
	});

	test("meta seed row is skipped (parity with muse-code)", () => {
		const seed = responsesSpec({ provider: "meta", name: "Muse Spark 1.3 (C)" });
		const [out] = applyGlobalModelsDevFallback([seed], [stencilReference]);
		expect(out.name).toBe("Muse Spark 1.3 (C)");
		expect(out.int).toBeUndefined();
		expect(out.tps).toBeUndefined();
	});

	test("a non-skipped provider sharing the id falls through to the stencil.so overlay", () => {
		const seed = responsesSpec({ provider: "custom", name: "Muse Spark 1.3 (C)" });
		const [out] = applyGlobalModelsDevFallback([seed], [stencilReference]);
		expect(out.name).toBe("Muse Spark 1.3 Contributor");
		expect(out.int).toBe(53);
		expect(out.tps).toBe(190.1);
	});
});
