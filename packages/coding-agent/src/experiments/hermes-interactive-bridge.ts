import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HermesGatewayClient, type HermesGatewayEvent } from "./hermes-gateway";

type JsonObject = Record<string, unknown>;
type StreamState = { text: string; model: string; started: boolean; tools: Map<string, string> };

export function hermesBackendEnabled(): boolean {
	return process.env.PI_HERMES_BACKEND === "1";
}

function textField(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const field = (value as JsonObject)[key];
	return typeof field === "string" && field.length > 0 ? field : undefined;
}

function assistantMessage(text: string, model: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "hermes",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}
function toolResultText(payload: JsonObject): string {
	const direct =
		textField(payload, "summary") ??
		textField(payload, "result_text") ??
		(typeof payload.result === "string" ? payload.result : undefined);
	if (direct) return direct;
	const result = payload.result;
	if (!result || typeof result !== "object" || Array.isArray(result)) return "";
	const body = result as JsonObject;
	return textField(body, "output") ?? textField(body, "stdout") ?? textField(body, "error") ?? "";
}

export function hermesEventToSessionEvents(event: HermesGatewayEvent, state: StreamState): AgentSessionEvent[] {
	const payload = event.payload ?? {};
	if (event.type === "message.delta") {
		const delta = textField(payload, "text") ?? textField(payload, "delta") ?? "";
		if (!delta) return [];
		state.text += delta;
		const message = assistantMessage(state.text, state.model);
		const events: AgentSessionEvent[] = [];
		if (!state.started) {
			state.started = true;
			events.push({ type: "agent_start" }, { type: "message_start", message });
		}
		events.push({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
		});
		return events;
	}
	if (event.type === "message.complete") {
		const finalText = textField(payload, "text");
		if (finalText) state.text = finalText;
		const message = assistantMessage(state.text, state.model);
		const events: AgentSessionEvent[] = [];
		if (!state.started && state.text) {
			events.push({ type: "agent_start" }, { type: "message_start", message });
		}
		state.started = false;
		events.push({ type: "message_end", message }, { type: "agent_end", messages: [message] });
		return events;
	}
	if (event.type === "tool.start") {
		const toolCallId = textField(payload, "tool_id");
		const toolName = textField(payload, "name") ?? "tool";
		if (!toolCallId) return [];
		state.tools.set(toolCallId, toolName);
		const args = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? payload.args : {};
		return [{ type: "tool_execution_start", toolCallId, toolName, args }];
	}
	if (event.type === "tool.complete") {
		const toolCallId = textField(payload, "tool_id");
		if (!toolCallId) return [];
		const toolName = textField(payload, "name") ?? state.tools.get(toolCallId) ?? "tool";
		state.tools.set(toolCallId, toolName);
		return [
			{
				type: "tool_execution_end",
				toolCallId,
				toolName,
				isError: false,
				result: { content: [{ type: "text", text: toolResultText(payload) }] },
			},
		];
	}
	return [];
}

export async function attachHermesBackend(session: AgentSession): Promise<void> {
	const gateway = new HermesGatewayClient();
	const stream: StreamState = {
		text: "",
		model: process.env.HERMES_MODEL?.trim() || "hermes",
		started: false,
		tools: new Map(),
	};
	gateway.start();
	gateway.on("event", (event: HermesGatewayEvent) => {
		for (const mapped of hermesEventToSessionEvents(event, stream)) {
			session.injectExternalEvent(mapped);
		}
		if (event.type === "message.complete") {
			stream.text = "";
			stream.started = false;
		}
	});
	await gateway.waitReady();
	await gateway.request("client.capabilities", { server_requests: false });
	const cwd = process.env.HERMES_CWD?.trim() || process.cwd();
	const created = await gateway.request<{ session_id?: string }>("session.create", {
		close_on_disconnect: true,
		cols: process.stdout.columns ?? 80,
		cwd,
		cwd_explicit: Boolean(process.env.HERMES_CWD?.trim()),
		model: process.env.HERMES_MODEL?.trim() || undefined,
		profile: process.env.HERMES_PROFILE?.trim() || undefined,
		source: "omp-hermes-experiment",
	});
	if (!created.session_id) throw new Error("session.create returned no session_id");
	const sessionId = created.session_id;
	const originalAbort = session.abort.bind(session);
	session.prompt = async (text: string) => {
		stream.text = "";
		stream.started = false;
		await gateway.request("prompt.submit", {
			session_id: sessionId,
			surface: "tui",
			text,
		});
		return true;
	};
	session.abort = async options => {
		await gateway.request("session.interrupt", { session_id: sessionId }).catch(() => undefined);
		return originalAbort(options);
	};
}
