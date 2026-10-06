import { describe, expect, it } from "bun:test";

import { resolveOmnaraBridgeCommand } from "../src/experiments/omnara-client";

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
});
