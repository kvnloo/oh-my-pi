import { describe, expect, it } from "bun:test";

import { safeDeclineResult, serverRequestReply } from "../src/experiments/hermes-gateway";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("Hermes approval server request", () => {
	it("declines with choice deny, never allow, and does not emit tool_execution_start", () => {
		const declined = safeDeclineResult("approval");
		expect(declined).toEqual({ choice: "deny" });
		expect(declined).not.toEqual({ choice: "allow" });
		expect(JSON.stringify(declined)).not.toContain("allow");

		const reply = serverRequestReply(7, "approval");
		expect(reply).toEqual({ id: 7, jsonrpc: "2.0", result: { choice: "deny" } });
		expect(JSON.stringify(reply)).not.toContain("allow");
		expect(reply.result).not.toMatchObject({ choice: "allow" });

		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const mapped = hermesEventToSessionEvents(
			{ type: "approval", payload: { id: 7, method: "approval" } },
			state,
		);
		expect(mapped).toEqual([]);
		expect(mapped.some(event => event.type === "tool_execution_start")).toBe(false);
	});
});
