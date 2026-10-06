import { describe, expect, it } from "bun:test";

import { safeDeclineResult } from "../src/experiments/hermes-gateway";

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
});
