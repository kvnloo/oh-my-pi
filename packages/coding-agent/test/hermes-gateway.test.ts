import { describe, expect, it } from "bun:test";

import { safeDeclineResult } from "../src/experiments/hermes-gateway";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("Hermes experiment safety fallback", () => {
	it("denies approval rather than inventing consent", () => {
		expect(safeDeclineResult("approval")).toEqual({ choice: "deny" });
	});

	it("cancels clarify and skips sensitive string prompts", () => {
		expect(safeDeclineResult("clarify")).toEqual({});
		expect(safeDeclineResult("secret")).toEqual({ value: "" });
		expect(safeDeclineResult("vault.unlock_prompt")).toEqual({ value: "" });
	});

	it("does not fabricate answers for unknown server requests", () => {
		expect(safeDeclineResult("unknown.future.request")).toBeUndefined();
	});

	it("returns an empty clarify result and does not select an option", () => {
		const result = safeDeclineResult("clarify");
		expect(result).toEqual({});
		expect(result).not.toHaveProperty("selected");
		expect(result).not.toHaveProperty("choice");
	});

	it("declines a secret request with an empty value and never maps the secret text", () => {
		const fixture = "fixture-not-a-live-secret";
		expect(safeDeclineResult("secret")).toEqual({ value: "" });
		expect(safeDeclineResult("password")).toEqual({ value: "" });
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const events = [
			...hermesEventToSessionEvents({ type: "tool.start", payload: { tool_id: "secret-1", name: "secret", args: { value: fixture } } }, state),
			...hermesEventToSessionEvents({ type: "tool.complete", payload: { tool_id: "secret-1", name: "secret", result: { output: fixture } } }, state),
		];
		expect(events).toEqual([]);
		expect(JSON.stringify(events)).not.toContain(fixture);
	});
});
