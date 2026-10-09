import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import {
	PUBLIC_EVIDENCE,
	ReceiptLog,
	applySpillOnly,
	compileCognitiveState,
	contextBytes,
	createCognitiveStateHandler,
	donorSpillStub,
	evidenceFromAgentsView,
	evidenceFromContextResolve,
	handleCognitiveStateContext,
	measureArms,
	messageText,
	resolveFromAgentsView,
	resolveFromZ0int,
	validateUnifiedReceipt,
} from "../examples/extensions/cognitive-state/index.ts";
import type { ArmBytes, ContextMessage, EvidenceRef } from "../examples/extensions/cognitive-state/index.ts";
import { growthFromPrevious } from "../examples/extensions/cognitive-state/index.ts";

const base = { sessionId: "sess-1", traceId: "trace-1", sourceRevision: "984fa8bcc5d4" };

function user(text: string): ContextMessage {
	return { role: "user", content: text, timestamp: 1 };
}

function toolResult(text: string): ContextMessage {
	return {
		role: "toolResult",
		toolName: "read",
		content: [{ type: "text", text }],
		timestamp: 2,
	};
}

function marked(id: string): ContextMessage[] {
	return [toolResult(`noise ${"x".repeat(100)}`), user(`z0evals#56:${id}\nanswer from evidence only`)];
}

describe("cognitive-state context seam", () => {
	it("shadow records the packet and still sends native context", async () => {
		const native = marked("exact-identifier");
		const before = JSON.stringify(native);
		const receipt = new ReceiptLog();
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: native },
			{ ...base, mode: "shadow", receipt },
		);
		expect(result.replacement).toBeUndefined();
		expect(result.injected).toBe(false);
		expect(result.sent).toBe("native");
		expect(result.analysis?.would_send_bytes).toBeGreaterThan(0);
		expect(result.receipt?.context_bytes).toBe(contextBytes(native));
		expect(result.visibleText).not.toContain("z0.cognitive_state.v1");
		expect(result.receipt?.evidence_refs.some(ref => ref.source_id === "z0int:context_resolve" && ref.trust_class === "code")).toBe(true);
		expect(JSON.stringify(native)).toBe(before);
		expect(receipt.lines).toHaveLength(1);
	});

	it("canary makes the packet model-visible without mutating the transcript", async () => {
		const native = marked("exact-identifier");
		const snapshot = native.map(message => ({ ...message, content: message.content }));
		const handler = createCognitiveStateHandler({ ...base, mode: "canary" });
		const returned = await handler({ type: "context", messages: native });
		expect(returned?.messages?.[0]?.role).toBe("user");
		expect(returned?.messages?.[0]?.synthetic).toBe(true);
		const visible = messageText(returned!.messages[0]!);
		expect(visible).toContain("z0.cognitive_state.v1");
		expect(visible).toContain("z0int.context_resolve.v1");
		expect(visible).not.toContain("noise ");
		expect(native).toEqual(snapshot);
		expect(messageText(returned!.messages[1]!)).toContain("z0evals#56:exact-identifier");
	});

	it("does not canary a non-frozen question", async () => {
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: [user("what is the weather")] },
			{ ...base, mode: "canary" },
		);
		expect(result.replacement).toBeUndefined();
		expect(result.injected).toBe(false);
		expect(result.receipt?.question_id).toBe("unscoped");
	});

	it("off does not compile a receipt", async () => {
		const receipt = new ReceiptLog();
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("exact-identifier") },
			{ ...base, mode: "off", receipt },
		);
		expect(result.sent).toBe("off");
		expect(receipt.lines).toHaveLength(0);
	});
});

describe("z0evals#56 canary proofs", () => {
	it("supports an answer only when the injected packet contains the evidence", async () => {
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("exact-identifier") },
			{ ...base, mode: "canary" },
		);
		expect(result.receipt?.injected).toBe(true);
		expect(result.receipt?.answer_supported).toBe(true);
		expect(result.receipt?.verified).toBe(true);
		expect(result.analysis?.evidence_quality).toBe("SUPPORTED");
		expect(result.receipt?.abstained).toBe(false);
	});

	it("abstains when a required source is removed", async () => {
		const evidence = PUBLIC_EVIDENCE.filter(ref => ref.source_id !== "z0int:context_resolve");
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("exact-identifier") },
			{ ...base, mode: "canary", evidence },
		);
		expect(result.visibleText).toContain("ABSTAIN");
		expect(result.visibleText).toContain("z0int:context_resolve: missing evidence");
		expect(result.visibleText).not.toContain("STANDUP-DECISION-ALPHA");
		expect(result.receipt?.abstained).toBe(true);
		expect(result.receipt?.answer_supported).toBe(false);
		expect(result.receipt?.verified).toBe(false);
		expect(result.analysis?.evidence_quality).toBe("MISSED_EVIDENCE");
	});

	it("abstains on the frozen missing-evidence question instead of inventing a fact", async () => {
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("missing-evidence") },
			{ ...base, mode: "canary" },
		);
		expect(result.visibleText).toContain("ABSTAIN");
		expect(result.visibleText).not.toContain("STANDUP-DECISION-ALPHA");
		expect(result.receipt?.verified).toBe(true);
		expect(result.receipt?.answer_supported).toBe(false);
		expect(result.receipt?.abstained).toBe(true);
	});

	it("replay does not append a second receipt or a second packet", async () => {
		const receipt = new ReceiptLog();
		const config = { ...base, mode: "canary" as const, receipt };
		const first = await handleCognitiveStateContext({ type: "context", messages: marked("cross-harness") }, config);
		const second = await handleCognitiveStateContext({ type: "context", messages: marked("cross-harness") }, config);
		expect(receipt.lines).toHaveLength(1);
		expect(second.replayed).toBe(true);
		expect(second.receipt?.duplicate_injection).toBe(false);
		expect(second.replacement).toEqual(first.replacement);
		const visible = messageText(second.replacement![0]!);
		expect(visible.match(/z0\.cognitive_state\.v1/g)).toHaveLength(2);
	});

	it("supersedes the current claim and keeps the older claim inspectable", async () => {
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("supersession") },
			{ ...base, mode: "canary" },
		);
		expect(result.visibleText).toContain("eval-fixture-cap=20480");
		expect(result.visibleText).toContain("status=observed");
		expect(result.visibleText).toContain("eval-fixture-cap=8192");
		expect(result.visibleText).toContain("status=superseded");
		expect(result.receipt?.answer_supported).toBe(true);
		const current = result.visibleText.split("history:")[0] ?? "";
		expect(current).toContain("eval-fixture-cap=20480");
		expect(current).not.toContain("eval-fixture-cap=8192");
	});

	it("does not drop an old uncontradicted claim by age", () => {
		const old = PUBLIC_EVIDENCE.find(ref => ref.source_id === "eval-fixture:old-uncontradicted");
		expect(old).toBeDefined();
		const packet = compileCognitiveState({
			intent: "age",
			evidence: [old as EvidenceRef],
			needs: [{ id: "old", description: "old", required: true }],
		});
		expect(packet.state.current).toHaveLength(1);
		expect(packet.state.current[0]?.status).toBe("observed");
		expect(packet.state.current[0]?.text).toBe("eval-fixture-old=still-current");
		expect(packet.knowledge.history).toHaveLength(0);
	});

	it("keeps both sides of a contradiction with provenance", async () => {
		const result = await handleCognitiveStateContext(
			{ type: "context", messages: marked("contradiction") },
			{ ...base, mode: "canary" },
		);
		expect(result.visibleText).toContain("eval-fixture-jsonl: retained");
		expect(result.visibleText).toContain("eval-fixture-jsonl: deleted");
		expect(result.visibleText).toContain("both retained");
		expect(result.visibleText).not.toContain("JSONL-DELETED-WINNER");
		expect(result.receipt?.answer_supported).toBe(false);
		expect(result.receipt?.verified).toBe(true);
		expect(result.analysis?.evidence_quality).toBe("UNSUPPORTED");
	});
});

describe("arms A/B/C", () => {
	it("spill-only stubs omit the payload middle and match the donor header", () => {
		const middle = "MIDDLEMARKER";
		const text = `${"a".repeat(400)}${middle}${"b".repeat(400)}`;
		const stub = donorSpillStub(text, 100, "1", "read");
		expect(stub.startsWith("[rlm spilled handle=rlm://h/1 bytes=")).toBe(true);
		expect(stub).toContain("Full payload is NOT in this message. Use the rlm tool (peek/search/query) on the handle.");
		expect(stub).not.toContain(middle);
		expect(Buffer.byteLength(stub)).toBeLessThan(Buffer.byteLength(text));
		expect(applySpillOnly([toolResult("short")], 100)[0]?.content).toEqual(toolResult("short").content);
	});

	it("state-packet growth stays flat while native context grows with the transcript", async () => {
		const turns: ContextMessage[][] = [];
		let native: ContextMessage[] = marked("minimal-context");
		const growthC: number[] = [];
		const growthA: number[] = [];
		let previous: ArmBytes | undefined;
		for (let index = 0; index < 4; index++) {
			native = [
				...native,
				toolResult(`${"q".repeat(40_000)}MIDDLE-${index}-SECRET${"z".repeat(40_000)}`),
			];
			turns.push(native);
			const result = await handleCognitiveStateContext(
				{ type: "context", messages: native },
				{ ...base, mode: "canary", traceId: `turn-${index}` },
			);
			const arms = measureArms(native, result.visibleText);
			const growth = growthFromPrevious(arms, previous);
			growthA.push(growth.native_context_bytes);
			growthC.push(growth.state_packet_bytes);
			previous = arms;
			expect(result.visibleText).toContain("z0int.context_resolve.v1");
			expect(result.visibleText).toContain("RLM_DEFAULT_SPILL_BYTES = 20480");
			expect(result.visibleText).not.toContain(`MIDDLE-${index}-SECRET`);
			expect(arms.state_packet_bytes).toBeLessThan(arms.native_context_bytes);
			expect(arms.rlm_spill_bytes).toBeLessThan(arms.native_context_bytes);
		}
		expect(growthA[3]).toBeGreaterThan(40_000);
		expect(growthC[3]).toBe(0);
		expect(turns.length).toBe(4);
		expect(contextBytes(turns[3]!)).toBeGreaterThan(contextBytes(turns[0]!));
	});
});


describe("evidence adapters", () => {
	it("maps a z0int context_resolve packet and counts exact-path reads", () => {
		const mapped = evidenceFromContextResolve({
			schema: "z0int.context_resolve.v1",
			evidence: [
				{
					source_id: "file:schema",
					source_version: "mtime=1:size=2",
					locator: "src/z0int/context_resolve.py",
					trust_class: "code",
					observed_at: "2026-09-29T00:00:00Z",
					excerpt: "z0int.context_resolve.v1",
				},
			],
			unresolved_gaps: [],
			recipe: { operations: [{ op: "exact_path", hit: true }] },
		});
		expect(mapped.retrieval_capability).toBe("z0int.context_resolve.v1");
		expect(mapped.raw_source_reads).toBe(1);
		expect(mapped.evidence[0]?.locator).toBe("src/z0int/context_resolve.py");
	});

	it("maps AgentsView matches to locators and does not treat search as a raw read", async () => {
		const refs = evidenceFromAgentsView(
			{
				matches: [
					{
						session_id: "abc-123",
						ordinal: 17,
						ordinal_range: [12, 24],
						snippet: "private snippet must stay out of receipts",
					},
				],
			},
			"2026-09-29T00:00:00Z",
		);
		expect(refs[0]?.locator).toBe("abc-123@12-24");
		expect(refs[0]?.trust_class).toBe("index_hit");
		const resolved = await resolveFromAgentsView("context_resolve", async () => ({
			code: 0,
			stdout: JSON.stringify({ matches: [{ session_id: "abc-123", ordinal: 1, ordinal_range: [1, 1] }] }),
			stderr: "",
		}));
		expect(resolved.raw_source_reads).toBe(0);
		expect(resolved.evidence[0]?.source_id).toBe("agentsview:abc-123");
		const down = await resolveFromZ0int("schema", async () => ({ code: 1, stdout: "", stderr: "no module" }));
		expect(down.evidence).toHaveLength(0);
		expect(down.gaps[0]).toContain("z0int: resolver unavailable");
	});
});

describe("z0eval receipt schema", () => {
	it("canary rows match z0eval.unified_memory_receipt.v0 and omit arm fields", async () => {
		const schema = JSON.parse(
			readFileSync(new URL("../evals/cognitive-state/receipt.schema.json", import.meta.url), "utf8"),
		) as { required?: string[]; properties?: Record<string, unknown> };
		const ids = ["exact-identifier", "supersession", "cross-harness", "contradiction", "missing-evidence", "minimal-context"];
		for (const id of ids) {
			const result = await handleCognitiveStateContext(
				{ type: "context", messages: marked(id) },
				{ ...base, mode: "canary", traceId: `schema-${id}` },
			);
			const errors = validateUnifiedReceipt(result.receipt, schema);
			expect(errors).toEqual([]);
			expect(result.receipt && "arms" in result.receipt).toBe(false);
			expect(result.receipt?.evidence_refs.every(ref => typeof ref.source_id === "string" && typeof ref.locator_hash === "string")).toBe(true);
		}
		expect(ids).toHaveLength(6);
	});
});
