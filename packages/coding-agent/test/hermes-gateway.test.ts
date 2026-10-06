import { describe, expect, it } from "bun:test";

import { safeDeclineResult } from "../src/experiments/hermes-gateway";

describe("Hermes experiment safety fallback", () => {
	it("denies approval rather than inventing consent", () => {
		expect(safeDeclineResult("approval")).toEqual({ choice: "deny" });
	});

	it("returns an empty clarify result, not a selected option, and emits no tool card", () => {
		const result = safeDeclineResult("clarify");
		expect(result).toEqual({});
		expect(result).not.toHaveProperty("selected");
		expect(result).not.toHaveProperty("choice");
		expect(result).not.toHaveProperty("option");
		expect(result).not.toHaveProperty("index");
		expect(result).not.toHaveProperty("name");
		expect(result).not.toHaveProperty("target");
		expect(result).not.toHaveProperty("targetKind");
		expect(result).not.toHaveProperty("status");
		const toolCardKeys = ["k", "name", "title", "target", "targetKind", "status"];
		expect(toolCardKeys.every((key) => !(key in (result ?? {})))).toBe(true);
	});

	it("skips sensitive string prompts", () => {
		expect(safeDeclineResult("secret")).toEqual({ value: "" });
		expect(safeDeclineResult("vault.unlock_prompt")).toEqual({ value: "" });
	});

	it("does not fabricate answers for unknown server requests", () => {
		expect(safeDeclineResult("unknown.future.request")).toBeUndefined();
	});
});
