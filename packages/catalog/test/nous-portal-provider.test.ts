import { describe, expect, test } from "bun:test";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { recoversCanonicalParams } from "@oh-my-pi/pi-catalog/compat/taxonomy";
import { getBundledModelReferenceIndex } from "@oh-my-pi/pi-catalog/identity/bundled";
import { resolveModelReference } from "@oh-my-pi/pi-catalog/identity/reference";
import {
	isCredentialScopedModelCacheProvider,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import { nousPortalModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";

const NOUS_PORTAL_BASE_URL = "https://inference-api.nousresearch.com/v1";

describe("Nous Portal provider", () => {
	test("catalog policy declares account-scoped canonical recovery", () => {
		const descriptor = providerEntry("nous-portal");
		expect(descriptor).toMatchObject({
			id: "nous-portal",
			defaultModel: "anthropic/claude-sonnet-4.6",
			envVars: ["NOUS_API_KEY"],
			dynamicModelsAuthoritative: true,
		});
		expect(descriptor?.discovery).toBeUndefined();
		expect(recoversCanonicalParams("nous-portal")).toBe(true);
		expect(isCredentialScopedModelCacheProvider("nous-portal")).toBe(true);
	});

	test("dynamic discovery recovers intrinsic params without pricing or foreign thinking routes", async () => {
		const index = getBundledModelReferenceIndex();
		const resold = [...index.exact.values()].find(model => {
			if (model.provider === "nous-portal" || !model.id.includes("/")) return false;
			const ref = resolveModelReference(model.id, index);
			return ref?.reasoning === true && ref.thinking !== undefined && (ref.contextWindow ?? 0) > 0;
		});
		if (!resold) throw new Error("no bundled reasoning model with thinking metadata for recovery test");

		const fetch = (async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [resold.id, "nous-portal/only-on-this-gateway"].map(id => ({
						id,
						object: "model",
						created: 0,
						owned_by: "nous",
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as unknown as typeof globalThis.fetch;

		const options = nousPortalModelManagerOptions({ apiKey: "sk-nous-test", fetch });
		const models = (await options.fetchDynamicModels?.()) ?? [];
		const byId = new Map(models.map(model => [model.id, model]));
		const canonical = resolveModelReference(resold.id, index);
		const recovered = byId.get(resold.id);

		expect(recovered?.baseUrl).toBe(NOUS_PORTAL_BASE_URL);
		expect(recovered?.contextWindow).toBe(canonical?.contextWindow ?? null);
		expect(recovered?.reasoning).toBe(true);
		expect(recovered?.thinking).toBeUndefined();
		expect(recovered?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

		const unknown = byId.get("nous-portal/only-on-this-gateway");
		expect(unknown?.contextWindow).toBeNull();
		expect(unknown?.reasoning).toBe(false);
	});

	test("authoritative cache identities isolate accounts and endpoints without exposing keys", () => {
		const apiKey = "sk-nous-lab-alpha-sensitive";
		const baseUrl = "https://proxy.example/v1";
		const accountA = resolveModelCacheProviderId("nous-portal", { apiKey, baseUrl });
		const accountB = resolveModelCacheProviderId("nous-portal", {
			apiKey: "sk-nous-lab-beta-sensitive",
			baseUrl,
		});
		const endpointB = resolveModelCacheProviderId("nous-portal", {
			apiKey,
			baseUrl: "https://other.example/v1",
		});

		expect(accountA).not.toBe(accountB);
		expect(accountA).not.toBe(endpointB);
		expect(accountB).not.toBe(endpointB);
		expect(accountA).toMatch(/^nous-portal:models-v1:[a-z0-9]+$/);
		expect(accountA).not.toContain(apiKey);
		expect(accountA).not.toContain(baseUrl);
	});

	test("startup resolver and manager use the same normalized namespace and discovery URL", async () => {
		const apiKey = "sk-nous-lab-startup";
		const configuredUrl = "https://PROXY.EXAMPLE:443/v1///";
		const canonicalUrl = "https://proxy.example/v1";
		const startupId = resolveModelCacheProviderId("nous-portal", {
			apiKey,
			baseUrl: configuredUrl,
		});
		expect(startupId).toBe(resolveModelCacheProviderId("nous-portal", { apiKey, baseUrl: canonicalUrl }));
		expect(startupId).toBe(
			resolveModelCacheProviderId("nous-portal", {
				apiKey,
				baseUrl: "  https://proxy.example/v1/  ",
			}),
		);

		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			urls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
			return Response.json({
				object: "list",
				data: [{ id: "nous-lab/discovered", object: "model", owned_by: "nous" }],
			});
		}) as typeof globalThis.fetch;
		const manager = nousPortalModelManagerOptions({ apiKey, baseUrl: configuredUrl, fetch: fakeFetch });
		expect(manager.cacheProviderId).toBe(startupId);
		const discovered = await manager.fetchDynamicModels?.();

		expect(urls).toEqual(["https://proxy.example/v1/models"]);
		expect(discovered?.map(model => ({ id: model.id, baseUrl: model.baseUrl }))).toEqual([
			{ id: "nous-lab/discovered", baseUrl: canonicalUrl },
		]);
	});
});
