import { describe, expect, it } from "bun:test";

import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";
import { safeDeclineResult } from "../src/experiments/hermes-gateway";

describe("Hermes experiment safety fallback", () => {
	it("denies approval rather than inventing consent", () => {
		expect(safeDeclineResult("approval")).toEqual({ choice: "deny" });
	});

	it("cancels clarify and skips sensitive string prompts", () => {
		expect(safeDeclineResult("clarify")).toEqual({});
		expect(safeDeclineResult("secret")).toEqual({ value: "" });
		expect(safeDeclineResult("password")).toEqual({ value: "" });
		expect(safeDeclineResult("vault.unlock_prompt")).toEqual({ value: "" });
	});

	it("does not fabricate answers for unknown server requests", () => {
		expect(safeDeclineResult("unknown.future.request")).toBeUndefined();
	});

	it("declines a secret request with an empty value and never maps the secret text", () => {
		const fixture = "fixture-not-a-live-secret";
		const decline = safeDeclineResult("secret");
		expect(decline).toEqual({ value: "" });
		expect(JSON.stringify(decline)).not.toContain(fixture);

		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const events = [
			...hermesEventToSessionEvents({ type: "secret", payload: { value: fixture } }, state),
			...hermesEventToSessionEvents(
				{ type: "tool.start", payload: { tool_id: "secret-1", name: "secret", args: { value: fixture } } },
				state,
			),
			...hermesEventToSessionEvents(
				{ type: "tool.complete", payload: { tool_id: "secret-1", name: "secret", result: { output: fixture } } },
				state,
			),
		];
		expect(events).toEqual([]);
		expect(JSON.stringify(events)).not.toContain(fixture);
	});
});
