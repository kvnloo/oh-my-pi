import { describe, expect, test } from "bun:test";
import { LocalSpillStore } from "../src/rlm-adapter.ts";
import { compileCognitiveState } from "../src/compiler.ts";

describe("session resume / audit history intact", () => {
	test("recompile does not mutate prior native snapshot", () => {
		const store = new LocalSpillStore();
		const messages = [
			{ role: "user" as const, content: "Resume session. Canonical transcript unchanged." },
			{
				role: "tool" as const,
				tool_name: "bash",
				tool_call_id: "r1",
				content: "previous turn output\n" + "hist ".repeat(200),
			},
			{ role: "assistant" as const, content: "Continuing from audit log." },
		];
		const snap = messages.map((m) => ({ ...m }));
		const a = compileCognitiveState({ messages, store, invariants: ["Canonical transcript unchanged"] });
		const b = compileCognitiveState({ messages, store, invariants: ["Canonical transcript unchanged"] });
		expect(messages).toEqual(snap);
		expect(a.native_context).toEqual(snap);
		expect(b.native_context).toEqual(snap);
		expect(a.packet.dialogue.latest_user_input).toContain("Resume session");
		expect(b.receipts[0]?.artifact_handle).toBeTruthy();
	});
});
