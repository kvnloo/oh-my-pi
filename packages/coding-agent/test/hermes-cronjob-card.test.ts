import { describe, expect, it } from "bun:test";
import { hermesEventToSessionEvents } from "../src/experiments/hermes-interactive-bridge";

describe("hermes cronjob_manage card", () => {
	it("maps one cronjob_manage id to a bash card showing action and job id", () => {
		const state = { text: "", model: "hermes", started: false, tools: new Map<string, string>() };
		const start = hermesEventToSessionEvents(
			{
				type: "tool.start",
				payload: {
					tool_id: "cron-1",
					name: "cronjob_manage",
					args: { action: "list", job_id: "job-42" },
				},
			},
			state,
		);
		expect(start).toHaveLength(1);
		expect(start[0]).toMatchObject({
			type: "tool_execution_start",
			toolCallId: "cron-1",
			toolName: "bash",
			args: { command: "cronjob list job-42" },
		});
	});
});
