import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

const museCodeBundledByName = new Map<string, string>(
	getBundledModels("muse-code").map(model => [model.id, model.name]),
);
const museCodeSeedByName = new Map<string, string>(
	seedModels("muse-code").map((model: { id: string; name: string }) => [model.id, model.name]),
);

describe("muse-code bundled contributor rows preserve the `(C)` seed name", () => {
	test.each([...museCodeSeedByName.entries()])("%s bundled name === seed name", (id, seedName) => {
		expect(museCodeBundledByName.get(id)).toBe(seedName);
	});
});
