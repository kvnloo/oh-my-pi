import { describe, expect, test } from "bun:test";
import { parseAgyRoute, isAgyFrontDoor } from "../src/parse-route.ts";

describe("parseAgyRoute", () => {
	test("slash research/implement", () => {
		expect(parseAgyRoute("/agy research why is latency high?")?.lane).toBe("AGY_RESEARCH");
		expect(parseAgyRoute("/agy implement fix the flaky test")?.lane).toBe("AGY_IMPLEMENT");
		expect(parseAgyRoute("/agy r investigate pool limits")?.prompt).toContain("investigate");
		expect(parseAgyRoute("/agy i add a null check")?.lane).toBe("AGY_IMPLEMENT");
	});

	test("prefixes", () => {
		expect(parseAgyRoute("agy:r survey failure modes")?.lane).toBe("AGY_RESEARCH");
		expect(parseAgyRoute("agy:i patch visibility rules")?.lane).toBe("AGY_IMPLEMENT");
	});

	test("non-agy prompts are not front-door", () => {
		expect(isAgyFrontDoor("please fix the bug")).toBe(false);
		expect(parseAgyRoute("/agy research")).toBeNull();
	});
});
