import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { MUSE_CODE_STATIC_MODELS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const museCodeBundledByName = new Map<string, string>(
	getBundledModels("muse-code").map(model => [model.id, model.name]),
);
const museCodeSeedByName = new Map<string, string>(MUSE_CODE_STATIC_MODELS.map(model => [model.id, model.name]));

describe("muse-code bundled contributor rows preserve the `(C)` seed name", () => {
	test.each([...museCodeSeedByName.entries()])("%s bundled name === seed name", (id, seedName) => {
		expect(museCodeBundledByName.get(id)).toBe(seedName);
	});
});
