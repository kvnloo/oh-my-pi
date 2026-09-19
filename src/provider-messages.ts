/**
 * Convert FixtureMessage virtual context into Extension context message shapes.
 * Keep roles compatible with AgentMessage-ish provider context.
 */

import type { FixtureMessage } from "./compiler.ts";

/** Minimal message shape accepted by emitContext replacements. */
export interface ProviderContextMessage {
	role: "user" | "assistant" | "toolResult" | "system" | "custom";
	content: string | Array<{ type: "text"; text: string }>;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	customType?: string;
	display?: boolean;
}

export function fixtureToProviderMessages(msgs: FixtureMessage[]): ProviderContextMessage[] {
	const out: ProviderContextMessage[] = [];
	// Lead with a compact packet continuity note as custom (display false) — optional.
	for (const m of msgs) {
		if (m.role === "tool") {
			out.push({
				role: "toolResult",
				content: [{ type: "text", text: m.content }],
				toolName: m.tool_name,
				toolCallId: m.tool_call_id,
				isError: m.is_error,
			});
			continue;
		}
		if (m.role === "system") {
			out.push({ role: "system", content: m.content });
			continue;
		}
		out.push({
			role: m.role,
			content: [{ type: "text", text: m.content }],
		});
	}
	return out;
}

export function injectPacketCustomMessage(
	messages: ProviderContextMessage[],
	packetJson: string,
): ProviderContextMessage[] {
	return [
		{
			role: "custom",
			customType: "z0.cognitive_state.v1",
			display: false,
			content: packetJson,
		},
		...messages,
	];
}
