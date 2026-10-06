import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { HermesGatewayClient, type HermesGatewayEvent } from "./hermes-gateway";

type JsonObject = Record<string, unknown>;

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

export function hermesEventToSessionEvents(
	event: HermesGatewayEvent,
	state: { text: string; model: string },
): AgentSessionEvent[] {
	const payload = event.payload ?? {};
	if (event.type === "message.delta") {
		const delta = textField(payload, "text") ?? textField(payload, "delta") ?? "";
		if (!delta) return [];
		state.text += delta;
		const message = assistantMessage(state.text, state.model);
		return [
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
			},
		];
	}
	if (event.type === "message.complete") {
		const finalText = textField(payload, "text");
		if (finalText) state.text = finalText;
		const message = assistantMessage(state.text, state.model);
		return [
			{ type: "message_end", message },
			{ type: "agent_end", messages: [message] },
		];
	}
	if (event.type === "tool.start") {
		const toolCallId = textField(payload, "tool_id") ?? textField(payload, "id");
		const toolName = textField(payload, "name") ?? textField(payload, "tool") ?? "tool";
		if (!toolCallId) return [];
		return [{ type: "tool_execution_start", toolCallId, toolName, args: payload.args ?? {} }];
	}
	if (event.type === "tool.complete") {
		const toolCallId = textField(payload, "tool_id") ?? textField(payload, "id");
		const toolName = textField(payload, "name") ?? textField(payload, "tool") ?? "tool";
		if (!toolCallId) return [];
		const text = textField(payload, "summary") ?? textField(payload, "output") ?? textField(payload, "error") ?? "";
		const isError = payload.status === "error" || payload.ok === false || Boolean(textField(payload, "error"));
		return [
			{
				type: "tool_execution_end",
				toolCallId,
				toolName,
				isError,
				result: { content: [{ type: "text", text }] },
			},
		];
	}
	return [];
}

export async function attachHermesBackend(session: AgentSession): Promise<void> {
	const gateway = new HermesGatewayClient();
	const stream = { text: "", model: process.env.HERMES_MODEL?.trim() || "hermes" };
	gateway.start();
	gateway.on("event", (event: HermesGatewayEvent) => {
		for (const mapped of hermesEventToSessionEvents(event, stream)) {
			session.injectExternalEvent(mapped);
		}
		if (event.type === "message.complete") stream.text = "";
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
