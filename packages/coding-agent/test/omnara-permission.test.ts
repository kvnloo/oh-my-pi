import { describe, expect, it } from "bun:test";

import { answerOmnaraInteraction, type OmnaraInteractiveHost } from "../src/experiments/omnara-interactive-bridge";

type Resolution = {
	agentID: string;
	interactionID: string;
	answers: Array<{ option_indices: number[]; text?: string }>;
};

function fakeClient(record: Resolution[]) {
	return {
		async resolveInteraction(
			agentID: string,
			interactionID: string,
			answers: Array<{ option_indices: number[]; text?: string }>,
		) {
			record.push({ agentID, interactionID, answers });
			return {};
		},
	};
}

function permission(agentID: string) {
	return {
		id: "perm_1",
		agent_id: agentID,
		agent_name: "Child reviewer",
		interaction_kind: "permission",
		tool_name: "run_command",
		request: {
			title: "Permission requested",
			context: [{ label: "Command", value: "rm generated.tmp" }],
			questions: [
				{
					prompt: "Allow this tool call?",
					options: [{ label: "Allow" }, { label: "Deny", allows_text: true }],
				},
			],
		},
	};
}

describe("Omnara permission interactions", () => {
	it("preserves Allow as option index 0", async () => {
		const resolutions: Resolution[] = [];
		const titles: string[] = [];
		const host: OmnaraInteractiveHost = {
			async showHookSelector(title) {
				titles.push(title);
				return "Allow";
			},
			async showHookInput() {
				throw new Error("Allow must not request denial text");
			},
			showHookNotify() {},
			showStatus() {},
		};

		expect(await answerOmnaraInteraction(fakeClient(resolutions), host, permission("agt_main"))).toBe("answered");
		expect(resolutions).toEqual([
			{
				agentID: "agt_main",
				interactionID: "perm_1",
				answers: [{ option_indices: [0] }],
			},
		]);
		expect(titles[0]).toContain("Permission requested · Child reviewer");
		expect(titles[0]).toContain("Command: rm generated.tmp");
	});

	it("preserves Deny as option index 1 and its optional reason", async () => {
		const resolutions: Resolution[] = [];
		const host: OmnaraInteractiveHost = {
			async showHookSelector() {
				return "Deny";
			},
			async showHookInput(title) {
				expect(title).toContain("Deny");
				return "not safe in this workspace";
			},
			showHookNotify() {},
			showStatus() {},
		};

		expect(await answerOmnaraInteraction(fakeClient(resolutions), host, permission("agt_child"))).toBe("answered");
		expect(resolutions).toEqual([
			{
				agentID: "agt_child",
				interactionID: "perm_1",
				answers: [{ option_indices: [1], text: "not safe in this workspace" }],
			},
		]);
	});

	it("dismissal does not fabricate a permission decision", async () => {
		const resolutions: Resolution[] = [];
		const host: OmnaraInteractiveHost = {
			async showHookSelector() {
				return undefined;
			},
			async showHookInput() {
				return undefined;
			},
			showHookNotify() {},
			showStatus() {},
		};

		expect(await answerOmnaraInteraction(fakeClient(resolutions), host, permission("agt_child"))).toBe("dismissed");
		expect(resolutions).toEqual([]);
	});
});
