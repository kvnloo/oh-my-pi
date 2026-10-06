import { describe, expect, it } from "bun:test";

import { OmnaraClient, resolveOmnaraBridgeCommand } from "../src/experiments/omnara-client";

describe("Omnara bridge command", () => {
	it("uses the installed CLI by default and preserves official env names", () => {
		const command = resolveOmnaraBridgeCommand({
			OMNARA_AGENT_ID: "agt_1",
			OMNARA_API_KEY: "key",
			OMNARA_ORG_ID: "org_1",
			OMNARA_PROJECT_ID: "proj_1",
		});

		expect(command.command).toBe("omnara");
		expect(command.args).toEqual(["agents", "bridge-omp", "agt_1"]);
		expect(command.env.OMNARA_API_KEY).toBe("key");
	});

	it("dogfoods the companion source checkout when OMNARA_ROOT is set", () => {
		const command = resolveOmnaraBridgeCommand({
			OMNARA_AGENT_ID: "agt_2",
			OMNARA_ROOT: "/src/omnara",
			OMNARA_PNPM: "pnpm-custom",
		});

		expect(command.command).toBe("pnpm-custom");
		expect(command.args).toEqual([
			"--dir",
			"/src/omnara/frontend",
			"--filter",
			"omnara",
			"run",
			"omnara",
			"--",
			"agents",
			"bridge-omp",
			"agt_2",
		]);
	});

	it("maps legacy experiment env names onto the official Omnara CLI names", () => {
		const command = resolveOmnaraBridgeCommand({
			OMNARA_AGENT_ID: "agt_3",
			OMNARA_TOKEN: "legacy-token",
			OMNARA_API: "http://localhost:8080/v1",
		});

		expect(command.env.OMNARA_API_KEY).toBe("legacy-token");
		expect(command.env.OMNARA_API_URL).toBe("http://localhost:8080/v1");
	});

	it("requires an agent id", () => {
		expect(() => resolveOmnaraBridgeCommand({})).toThrow("OMNARA_AGENT_ID");
	});

	it("speaks request/response and stream notifications over the child protocol", async () => {
		const childScript = [
			'const readline = require("node:readline");',
			"const rl = readline.createInterface({ input: process.stdin });",
			'const send = value => process.stdout.write(JSON.stringify(value) + "\\n");',
			'send({ jsonrpc: "2.0", method: "ready", params: { agent_id: "agt_test" } });',
			'rl.on("line", line => {',
			"  const request = JSON.parse(line);",
			'  if (request.method === "agent.get") send({ jsonrpc: "2.0", id: request.id, result: { agent: { name: "remote" } } });',
			'  if (request.method === "stream.start") {',
			'    send({ jsonrpc: "2.0", id: request.id, result: { started: true } });',
			'    send({ jsonrpc: "2.0", method: "stream.connection", params: { state: "connected", reconnected: false } });',
			'    send({ jsonrpc: "2.0", method: "stream.event", params: { event: "agent_input", id: "4", data: { event_kind: "agent_input", sequence: 4, input_kind: "content" } } });',
			"  }",
			'  if (request.method === "stream.stop") send({ jsonrpc: "2.0", id: request.id, result: { stopped: true } });',
			"});",
		].join("\n");
		const client = new OmnaraClient({
			command: process.execPath,
			args: ["-e", childScript],
			env: process.env,
		});

		try {
			expect(await client.getAgent()).toEqual({ agent: { name: "remote" } });

			const abort = new AbortController();
			const states: string[] = [];
			const frames = client.streamEvents({
				afterSequence: 3,
				signal: abort.signal,
				onConnectionStateChange: state => states.push(state.state),
			});
			const first = await frames.next();
			abort.abort();
			expect((await frames.next()).done).toBe(true);

			expect(states).toEqual(["connected"]);
			expect(first.value).toEqual({
				event: "agent_input",
				id: "4",
				data: JSON.stringify({ event_kind: "agent_input", sequence: 4, input_kind: "content" }),
			});
		} finally {
			client.close();
		}
	});
});
