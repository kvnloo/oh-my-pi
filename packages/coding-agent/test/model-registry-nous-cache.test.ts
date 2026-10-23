import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import {
	normalizeNousPortalBaseUrl,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { nousPortalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

test("Nous startup hydration reads only the current account and normalized endpoint's cache", async () => {
	using tempDir = TempDir.createSync("@omp-nous-cache-lab-");
	const cacheDbPath = tempDir.join("models.db");
	const providerId = "nous-portal";
	const cases = [
		{
			apiKey: "sk-nous-fixture-account-a",
			baseUrl: "https://PROXY.EXAMPLE:443/v1///",
			discoveryBaseUrl: "https://proxy.example/v1",
			modelId: "lab/account-a-model",
		},
		{
			apiKey: "sk-nous-fixture-account-b",
			baseUrl: "https://proxy.example/v1",
			discoveryBaseUrl: "https://proxy.example/v1",
			modelId: "lab/account-b-model",
		},
		{
			apiKey: "sk-nous-fixture-account-a",
			baseUrl: "https://other.example/v1/",
			discoveryBaseUrl: "https://other.example/v1",
			modelId: "lab/other-endpoint-model",
		},
	] as const;

	for (const fixture of cases) {
		const cacheProviderId = resolveModelCacheProviderId(providerId, fixture);
		expect(nousPortalModelManagerOptions(fixture).cacheProviderId).toBe(cacheProviderId);
		const model = buildModel({
			id: fixture.modelId,
			name: fixture.modelId,
			api: "openai-completions",
			provider: providerId,
			baseUrl: fixture.discoveryBaseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		writeModelCache(cacheProviderId, Date.now(), [model], true, "", cacheDbPath);
	}

	for (const [index, fixture] of cases.entries()) {
		const modelsPath = tempDir.join(`models-${index}.json`);
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					[providerId]: { baseUrl: fixture.baseUrl },
				},
			}),
		);
		const authStorage = await AuthStorage.create(":memory:");
		try {
			authStorage.keys.setRuntime(providerId, fixture.apiKey);
			let requests = 0;
			const registry = new ModelRegistry(authStorage, modelsPath, {
				cacheDbPath,
				fetch: () => {
					requests++;
					return Promise.reject(new Error("Offline Nous cache hydration must not issue provider requests"));
				},
			});

			// Startup cannot load account-scoped rows before the credential is known.
			expect(registry.find(providerId, fixture.modelId)).toBeUndefined();
			await registry.hydrateCredentialScopedModelCaches();

			const selected = registry.find(providerId, fixture.modelId);
			expect(selected).toMatchObject({
				provider: providerId,
				id: fixture.modelId,
			});
			expect(normalizeNousPortalBaseUrl(selected!.baseUrl)).toBe(fixture.discoveryBaseUrl);
			for (const other of cases) {
				if (other.modelId !== fixture.modelId) {
					expect(registry.find(providerId, other.modelId)).toBeUndefined();
				}
			}
			expect(requests).toBe(0);
		} finally {
			authStorage.close();
		}
	}
});
