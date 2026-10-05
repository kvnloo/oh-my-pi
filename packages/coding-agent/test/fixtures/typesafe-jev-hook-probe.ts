import assert from "node:assert/strict";
import path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const home = process.env.HOME!;
let requests = 0;
globalThis.fetch = Object.assign(
	async (input: string | URL | Request) => {
		assert.equal(String(input), "https://fixture.invalid/v1/systemone");
		requests++;
		return Response.json({
			answers: {
				which: { choice: "alpha", probabilities: { alpha: 1, beta: 0 } },
				"gate::acts_on_user_system": { noul: 1 },
				"gate::would_follow_documented_procedure": { noul: 1 },
				"gate::prose_suffices": { noul: 0 },
			},
			model: "fixture",
		});
	},
	{ preconnect() {} },
);
const auth = await AuthStorage.create(path.join(home, "auth.db"));
try {
	const loaded = await loadExtensions([process.argv[2]], home);
	assert.deepEqual(loaded.errors, []);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		home,
		SessionManager.inMemory(),
		new ModelRegistry(auth),
	);
	const original = ["Existing policy", "Existing context"];
	const result = await runner.emitBeforeAgentStart("Use the alpha procedure", undefined, original);
	console.log(JSON.stringify({ result, original, requests }));
} finally {
	auth.close();
}
