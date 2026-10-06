import { describe, expect, it } from "bun:test";

import { OmnaraClient } from "../src/experiments/omnara-client";

function clientWithRecorder() {
	const childScript = [
		'const readline = require("node:readline");',
		"const rl = readline.createInterface({ input: process.stdin });",
		'const send = value => process.stdout.write(JSON.stringify(value) + "\\n");',
		'send({ jsonrpc: "2.0", method: "ready", params: { agent_id: "agt_test" } });',
		'rl.on("line", line => {',
		"  const request = JSON.parse(line);",
		'  if (request.method === "agent.cancel") send({ jsonrpc: "2.0", id: request.id, result: { method: request.method, params: request.params } });',
		"});",
	].join("\n");
	return new OmnaraClient({
		command: process.execPath,
		args: ["-e", childScript],
		env: process.env,
	});
}

describe("Omnara interrupt bridge", () => {
	it("sends agent.cancel with no interaction answer payload", async () => {
		const client = clientWithRecorder();
		try {
			const result = await client.cancel<{ method: string; params: Record<string, unknown> }>();
			expect(result).toEqual({ method: "agent.cancel", params: {} });
			expect(result.params).not.toHaveProperty("answers");
			expect(result.params).not.toHaveProperty("approve");
			expect(result.params).not.toHaveProperty("choice");
		} finally {
			client.close();
		}
	});

	it("repeated Stop remains cancellation-only", async () => {
		const client = clientWithRecorder();
		try {
			const first = await client.cancel<{ method: string; params: Record<string, unknown> }>();
			const second = await client.cancel<{ method: string; params: Record<string, unknown> }>();
			expect(first).toEqual(second);
			expect(Object.keys(second.params)).toEqual([]);
		} finally {
			client.close();
		}
	});
});
