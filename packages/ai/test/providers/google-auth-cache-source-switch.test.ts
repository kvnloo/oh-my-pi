import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { __resetVertexTokenCache, getVertexAccessToken } from "../../src/providers/google-auth";
import type { FetchImpl } from "../../src/types";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/** Writes an `authorized_user` ADC file (the cheapest flow to mint against: a refresh grant). */
async function writeAuthorizedUser(dir: string, file: string, clientId: string): Promise<string> {
	const adcPath = path.join(dir, file);
	await Bun.write(
		adcPath,
		JSON.stringify({
			type: "authorized_user",
			client_id: clientId,
			client_secret: "client-secret",
			refresh_token: "refresh-token",
		}),
	);
	return adcPath;
}

describe("getVertexAccessToken cache source switch", () => {
	let tmpDir: string;
	let originalGac: string | undefined;
	let originalExplicit: string | undefined;
	let originalExplicit2: string | undefined;

	beforeEach(async () => {
		__resetVertexTokenCache();
		originalGac = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		originalExplicit = Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
		originalExplicit2 = Bun.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
		delete Bun.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-source-switch-"));
	});

	afterEach(async () => {
		__resetVertexTokenCache();
		if (originalGac === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalGac;
		if (originalExplicit === undefined) delete Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN;
		else Bun.env.GOOGLE_CLOUD_ACCESS_TOKEN = originalExplicit;
		if (originalExplicit2 === undefined) delete Bun.env.CLOUDSDK_AUTH_ACCESS_TOKEN;
		else Bun.env.CLOUDSDK_AUTH_ACCESS_TOKEN = originalExplicit2;
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	/**
	 * Returns a fetch mock that mints monotonically-numbered tokens at OAUTH_TOKEN_URL
	 * (one new token per call) and records each token-endpoint request body so the
	 * test can assert *which* ADC identity (client_id) was used and *how many*
	 * mints happened.
	 */
	function mintingOAuthFetch(): { fetchImpl: FetchImpl; oauthCalls: URLSearchParams[] } {
		const oauthCalls: URLSearchParams[] = [];
		const fetchImpl: FetchImpl = (input, init) => {
			const url = urlOf(input);
			if (url === OAUTH_TOKEN_URL) {
				oauthCalls.push(new URLSearchParams(String(init?.body ?? "")));
				return Promise.resolve(
					new Response(JSON.stringify({ access_token: `TOKEN-${oauthCalls.length}`, expires_in: 3600 })),
				);
			}
			return Promise.resolve(new Response("unexpected", { status: 404 }));
		};
		return { fetchImpl, oauthCalls };
	}

	it("re-mints when GOOGLE_APPLICATION_CREDENTIALS is repointed between calls (stale-identity regression)", async () => {
		const pathA = await writeAuthorizedUser(tmpDir, "adc-a.json", "id-A");
		const pathB = await writeAuthorizedUser(tmpDir, "adc-b.json", "id-B");
		const { fetchImpl, oauthCalls } = mintingOAuthFetch();

		// Call 1: source = gac:pathA -> mint TOKEN-1 for id-A.
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = pathA;
		const tokenA = await getVertexAccessToken({ fetch: fetchImpl });
		expect(tokenA).toBe("TOKEN-1");
		expect(oauthCalls).toHaveLength(1);
		expect(oauthCalls[0].get("client_id")).toBe("id-A");

		// Call 2: repoint to pathB without clearing the cache. The still-valid
		// TOKEN-1 entry lives under `gac:pathA`; the probe-loop bug served it
		// here. After the fix the active source is `gac:pathB`, the cache lookup
		// misses, and a fresh TOKEN-2 is minted for id-B.
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = pathB;
		const tokenB = await getVertexAccessToken({ fetch: fetchImpl });
		expect(tokenB).toBe("TOKEN-2");
		expect(oauthCalls).toHaveLength(2);
		expect(oauthCalls[1].get("client_id")).toBe("id-B");
	});

	it("re-mints after the well-known user ADC file replaces metadata as the active source", async () => {
		// Neutralize the developer's real ~/.config/gcloud ADC file so the
		// user:<path> source is entirely under test control, then point homedir
		// at an empty tmp dir (no user ADC file yet => metadata is active).
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-home-absent-"));
		const userAdcPath = path.join(fakeHome, ".config", "gcloud", "application_default_credentials.json");
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		try {
			const oauthCalls: URLSearchParams[] = [];
			let metadataCalls = 0;
			const fetchImpl: FetchImpl = (input, init) => {
				const url = urlOf(input);
				if (url === METADATA_TOKEN_URL) {
					metadataCalls++;
					return Promise.resolve(
						new Response(JSON.stringify({ access_token: `META-${metadataCalls}`, expires_in: 3600 })),
					);
				}
				if (url === OAUTH_TOKEN_URL) {
					oauthCalls.push(new URLSearchParams(String(init?.body ?? "")));
					return Promise.resolve(
						new Response(JSON.stringify({ access_token: `USER-${oauthCalls.length}`, expires_in: 3600 })),
					);
				}
				return Promise.resolve(new Response("unexpected", { status: 404 }));
			};

			// Call 1: no env, no user ADC file -> metadata active. Mints META-1.
			const tokenMeta = await getVertexAccessToken({ fetch: fetchImpl });
			expect(tokenMeta).toBe("META-1");
			expect(metadataCalls).toBe(1);
			expect(oauthCalls).toHaveLength(0);

			// "gcloud auth application-default login": create the well-known user
			// ADC file. Active source flips metadata -> user:<userAdcPath> without
			// a process restart. The still-valid META-1 entry lives under
			// `metadata`; the probe-loop bug served it. After the fix the cache
			// lookup misses on `user:<userAdcPath>` and a fresh USER-1 is minted.
			await fs.mkdir(path.dirname(userAdcPath), { recursive: true });
			await Bun.write(
				userAdcPath,
				JSON.stringify({
					type: "authorized_user",
					client_id: "user-id",
					client_secret: "user-secret",
					refresh_token: "user-refresh",
				}),
			);
			const tokenUser = await getVertexAccessToken({ fetch: fetchImpl });
			expect(tokenUser).toBe("USER-1");
			expect(oauthCalls).toHaveLength(1);
			expect(oauthCalls[0].get("client_id")).toBe("user-id");
			expect(metadataCalls).toBe(1); // no new metadata fetch despite still-valid META-1
		} finally {
			homedirSpy.mockRestore();
			await fs.rm(fakeHome, { recursive: true, force: true });
		}
	});

	it("re-mints after the well-known user ADC file is revoked (user: -> metadata fallback)", async () => {
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-home-present-"));
		const userAdcPath = path.join(fakeHome, ".config", "gcloud", "application_default_credentials.json");
		await fs.mkdir(path.dirname(userAdcPath), { recursive: true });
		await Bun.write(
			userAdcPath,
			JSON.stringify({
				type: "authorized_user",
				client_id: "user-id",
				client_secret: "user-secret",
				refresh_token: "user-refresh",
			}),
		);
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		try {
			let oauthCalls = 0;
			let metadataCalls = 0;
			const fetchImpl: FetchImpl = (input, init) => {
				const url = urlOf(input);
				if (url === METADATA_TOKEN_URL) {
					metadataCalls++;
					return Promise.resolve(
						new Response(JSON.stringify({ access_token: `META-${metadataCalls}`, expires_in: 3600 })),
					);
				}
				if (url === OAUTH_TOKEN_URL) {
					oauthCalls++;
					const clientId = new URLSearchParams(String(init?.body ?? "")).get("client_id");
					return Promise.resolve(
						new Response(JSON.stringify({ access_token: `USER-${oauthCalls}-${clientId}`, expires_in: 3600 })),
					);
				}
				return Promise.resolve(new Response("unexpected", { status: 404 }));
			};

			// Call 1: user ADC present -> user:<path> active. Mints USER-1-user-id.
			const tokenUser = await getVertexAccessToken({ fetch: fetchImpl });
			expect(tokenUser).toBe("USER-1-user-id");
			expect(oauthCalls).toBe(1);
			expect(metadataCalls).toBe(0);

			// "gcloud auth application-default revoke": delete the user ADC file.
			// Active source flips user:<path> -> metadata without a restart. The
			// still-valid USER-1 entry lives under `user:<path>`; the probe-loop
			// bug served it. After the fix the cache lookup misses on `metadata`
			// and a fresh META-1 is fetched from the metadata server.
			await fs.rm(userAdcPath);
			const tokenMeta = await getVertexAccessToken({ fetch: fetchImpl });
			expect(tokenMeta).toBe("META-1");
			expect(metadataCalls).toBe(1);
			expect(oauthCalls).toBe(1); // no new OAuth exchange despite still-valid USER-1
		} finally {
			homedirSpy.mockRestore();
			await fs.rm(fakeHome, { recursive: true, force: true });
		}
	});

	it("serves a cached token on the same source (steady-state cache hit, no regression)", async () => {
		const adcPath = await writeAuthorizedUser(tmpDir, "adc-single.json", "id-S");
		const { fetchImpl, oauthCalls } = mintingOAuthFetch();

		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
		const t1 = await getVertexAccessToken({ fetch: fetchImpl });
		const t2 = await getVertexAccessToken({ fetch: fetchImpl });

		expect(t1).toBe(t2);
		expect(oauthCalls).toHaveLength(1); // only the first call mints; second is a cache hit
	});

	it("re-mints on the same source once the cached token is past the refresh skew", async () => {
		const adcPath = await writeAuthorizedUser(tmpDir, "adc-exp.json", "id-E");
		const oauthCalls: URLSearchParams[] = [];
		// expires_in: 0 => the entry is born already past the skew window, so the
		// next call must discard the cached token and mint again.
		const fetchImpl: FetchImpl = (input, init) => {
			const url = urlOf(input);
			if (url === OAUTH_TOKEN_URL) {
				oauthCalls.push(new URLSearchParams(String(init?.body ?? "")));
				return Promise.resolve(
					new Response(JSON.stringify({ access_token: `TOKEN-${oauthCalls.length}`, expires_in: 0 })),
				);
			}
			return Promise.resolve(new Response("unexpected", { status: 404 }));
		};

		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;
		const t1 = await getVertexAccessToken({ fetch: fetchImpl });
		const t2 = await getVertexAccessToken({ fetch: fetchImpl });
		expect(t1).toBe("TOKEN-1");
		expect(t2).toBe("TOKEN-2"); // expired per skew => not reused
		expect(oauthCalls).toHaveLength(2);
		expect(oauthCalls[1].get("client_id")).toBe("id-E");
	});

	it("does not hand a wrong-source token to a caller that arrives while a different source is in-flight", async () => {
		const pathA = await writeAuthorizedUser(tmpDir, "adc-resolve-a.json", "id-RA");
		const pathB = await writeAuthorizedUser(tmpDir, "adc-resolve-b.json", "id-RB");

		// `loadAdcCredentials` re-reads `GOOGLE_APPLICATION_CREDENTIALS` at
		// resolve time, so we only flip the env *after* caller 1 has actually
		// reached the token-exchange fetch (proving it read pathA). The fetch
		// mock gates caller 1's response until caller 2 has had a chance to
		// enter getVertexAccessToken under the new source.
		const oauthCalls: URLSearchParams[] = [];
		const gate = Promise.withResolvers<void>();
		const caller1ReachedExchange = Promise.withResolvers<void>();
		const fetchImpl: FetchImpl = (input, init) => {
			const url = urlOf(input);
			if (url === OAUTH_TOKEN_URL) {
				const body = new URLSearchParams(String(init?.body ?? ""));
				oauthCalls.push(body);
				if (body.get("client_id") === "id-RA") {
					// Park the pathA resolve; the test releases it once caller 2
					// is in flight for pathB.
					caller1ReachedExchange.resolve();
					return gate.promise.then(
						() => new Response(JSON.stringify({ access_token: "TOKEN-A", expires_in: 3600 })),
					);
				}
				return Promise.resolve(
					new Response(JSON.stringify({ access_token: `TOKEN-B-${oauthCalls.length}`, expires_in: 3600 })),
				);
			}
			return Promise.resolve(new Response("unexpected", { status: 404 }));
		};

		// Caller 1: source = gac:pathA. Its resolve runs in a microtask, reads
		// pathA, and reaches the parked token exchange.
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = pathA;
		const caller1 = getVertexAccessToken({ fetch: fetchImpl });
		await caller1ReachedExchange.promise;

		// Now flip the active source. Caller 2 must NOT attach to caller 1's
		// in-flight mint (which would hand it TOKEN-A — a token for the *old*
		// identity — under the old single-slot dedup). It must start a fresh
		// mint for source B and receive a B-identity token.
		Bun.env.GOOGLE_APPLICATION_CREDENTIALS = pathB;
		const caller2 = getVertexAccessToken({ fetch: fetchImpl });

		// Release caller 1's parked resolve.
		gate.resolve();

		const [t1, t2] = await Promise.all([caller1, caller2]);
		expect(t1).toBe("TOKEN-A"); // caller 1 gets its own (parked) source's token
		expect(t2).toBe("TOKEN-B-2"); // caller 2 mints a fresh token for source B, not TOKEN-A
		const clientIds = oauthCalls.map(p => p.get("client_id"));
		expect(clientIds).toContain("id-RA");
		expect(clientIds).toContain("id-RB");
	});
});
