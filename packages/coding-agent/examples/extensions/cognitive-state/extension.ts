import { ReceiptLog, configFromEnv, createCognitiveStateHandler } from "./handle.ts";
import type { ContextMessage } from "./types.ts";

type SessionLike = { getSessionId?: () => string };

/**
 * Opt-in extension. Load with `--extension examples/extensions/cognitive-state/extension.ts`.
 * Default mode is shadow: native context is sent, the packet is only recorded.
 * `OMP_COGNITIVE_STATE=canary` replaces the provider view only when the latest
 * user message contains `z0evals#56:<frozen-id>`. Canonical session messages
 * are not an argument this handler can write.
 */
export default function cognitiveStateExtension(pi: {
	on(
		event: "context",
		handler: (
			event: { type: "context"; messages: ContextMessage[] },
			ctx?: { sessionManager?: SessionLike },
		) => Promise<{ messages: ContextMessage[] } | undefined> | { messages: ContextMessage[] } | undefined,
	): void;
}): void {
	const receipt = new ReceiptLog();
	pi.on("context", async (event, ctx) => {
		const base = configFromEnv();
		const sessionId = ctx?.sessionManager?.getSessionId?.() ?? base.sessionId;
		return createCognitiveStateHandler({ ...base, sessionId, receipt })(event);
	});
}
