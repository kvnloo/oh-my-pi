import { describe, expect, test } from "bun:test";
import { classifyVisibility, mayExternalizeRaw } from "../src/visibility.ts";

describe("visibility rules", () => {
	test("latest user input is LIVE", () => {
		expect(classifyVisibility({ kind: "user_input" })).toBe("LIVE");
	});

	test("unresolved failing test stays LIVE", () => {
		expect(
			classifyVisibility({ kind: "test_run", status: "error", unresolved: true, has_receipt: true }),
		).toBe("LIVE");
	});

	test("completed passing suite with receipt is RECEIPT", () => {
		expect(
			classifyVisibility({ kind: "test_run", status: "ok", has_receipt: true, verified: true }),
		).toBe("RECEIPT");
	});

	test("raw body without receipt is EXTERNAL or LIVE if required", () => {
		expect(classifyVisibility({ kind: "tool_result", status: "ok", has_receipt: false })).toBe("EXTERNAL");
		expect(
			classifyVisibility({ kind: "tool_result", status: "ok", has_receipt: false, raw_required: true }),
		).toBe("LIVE");
	});

	test("superseded plan is ARCHIVED", () => {
		expect(classifyVisibility({ kind: "plan", superseded: true })).toBe("ARCHIVED");
	});

	test("verified commit is RECEIPT", () => {
		expect(classifyVisibility({ kind: "commit", verified: true })).toBe("RECEIPT");
	});

	test("mayExternalizeRaw blocks unresolved", () => {
		expect(mayExternalizeRaw("RECEIPT", true)).toBe(false);
		expect(mayExternalizeRaw("RECEIPT", false)).toBe(true);
	});
});
