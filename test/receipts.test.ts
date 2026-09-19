import { describe, expect, test } from "bun:test";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import { createToolReceipt, extractFacts } from "../src/receipts.ts";

describe("tool receipts", () => {
	test("spills raw output and keeps handle/facts", () => {
		const store = new LocalSpillStore();
		const raw = "58/58 tests pass\nexit code: 0\n" + "z".repeat(5000);
		const receipt = createToolReceipt(store, {
			tool: "bash",
			tool_call_id: "t1",
			output: raw,
		});
		expect(receipt.schema).toBe("z0.tool_receipt.v1");
		expect(receipt.artifact_handle.startsWith("rlm://h/")).toBe(true);
		expect(receipt.raw_bytes).toBeGreaterThan(1000);
		expect(receipt.facts.length).toBeGreaterThan(0);
		expect(store.get(receipt.artifact_handle)?.text).toBe(raw);
		expect(receipt.visibility).toBe("RECEIPT");
	});

	test("error receipts stay LIVE and unresolved", () => {
		const store = new LocalSpillStore();
		const receipt = createToolReceipt(store, {
			tool: "bash",
			tool_call_id: "t2",
			is_error: true,
			output: "Error: hang\nexit code: 1",
		});
		expect(receipt.status).toBe("error");
		expect(receipt.visibility).toBe("LIVE");
	});

	test("extractFacts finds pass counts", () => {
		const facts = extractFacts("PASS\n24/24 tests pass\nexit code: 0");
		expect(facts.some((f) => /24/.test(f))).toBe(true);
	});
});
