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

function multiSelectHost(): OmnaraInteractiveHost & { warnings: string[] } {
	let step = 0;
	const warnings: string[] = [];
	return {
		warnings,
		async showHookSelector(_title, options) {
			step++;
			if (step === 1) {
				for (const item of options) if (typeof item !== "string" && item.label.includes("Alpha")) return item.label;
			}
			if (step === 2) {
				for (const item of options) if (typeof item !== "string" && item.label.includes("Beta")) return item.label;
			}
			return "Done";
		},
		async showHookInput() {
			return "use both";
		},
		showHookNotify(message, type) {
			if (type === "warning") warnings.push(message);
		},
		showStatus() {},
	};
}

describe("Omnara question interactions", () => {
	it("preserves multi-select option indices and one allowed companion note", async () => {
		const resolutions: Resolution[] = [];
		const result = await answerOmnaraInteraction(fakeClient(resolutions), multiSelectHost(), {
			id: "int_multi",
			agent_id: "agt_child",
			agent_name: "Reviewer",
			interaction_kind: "question",
			request: {
				title: "Questions",
				questions: [
					{
						prompt: "Which checks?",
						multiple: true,
						options: [{ label: "Alpha" }, { label: "Beta", allows_text: true }, { label: "Gamma" }],
					},
				],
			},
		});

		expect(result).toBe("answered");
		expect(resolutions).toEqual([
			{
				agentID: "agt_child",
				interactionID: "int_multi",
				answers: [{ option_indices: [0, 1], text: "use both" }],
			},
		]);
	});

	it("requires at least one selected option before Done", async () => {
		const resolutions: Resolution[] = [];
		let calls = 0;
		const warnings: string[] = [];
		const host: OmnaraInteractiveHost = {
			async showHookSelector(_title, options) {
				calls++;
				if (calls === 1) return "Done";
				if (calls === 2) {
					for (const item of options)
						if (typeof item !== "string" && item.label.includes("Gamma")) return item.label;
				}
				return "Done";
			},
			async showHookInput() {
				return undefined;
			},
			showHookNotify(message, type) {
				if (type === "warning") warnings.push(message);
			},
			showStatus() {},
		};

		const result = await answerOmnaraInteraction(fakeClient(resolutions), host, {
			id: "int_required",
			agent_id: "agt_main",
			interaction_kind: "question",
			request: {
				title: "Question",
				questions: [
					{
						prompt: "Pick at least one",
						multiple: true,
						options: [{ label: "Alpha" }, { label: "Gamma" }],
					},
				],
			},
		});

		expect(result).toBe("answered");
		expect(warnings).toEqual(["Select at least one option before continuing"]);
		expect(resolutions[0]?.answers).toEqual([{ option_indices: [1] }]);
	});

	it("dismissal leaves the Omnara interaction unresolved", async () => {
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
		const result = await answerOmnaraInteraction(fakeClient(resolutions), host, {
			id: "int_dismiss",
			agent_id: "agt_main",
			interaction_kind: "question",
			request: {
				title: "Question",
				questions: [{ prompt: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }],
			},
		});
		expect(result).toBe("dismissed");
		expect(resolutions).toEqual([]);
	});
});
