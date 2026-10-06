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
function ompToolName(name: string, raw: JsonObject = {}): string {
	if (name === "terminal" || name === "shell") return "bash";
	if (name === "read_file") return "read";
	if (name === "write_file") return "write";
	if (name === "patch") return "edit";
	if (name === "search_files") return raw.target === "files" ? "glob" : "grep";
	return name;
}

function ompToolArgs(name: string, raw: JsonObject): JsonObject {
	const kind = ompToolName(name, raw);
	if (kind === "bash") {
		const command = textField(raw, "command") ?? textField(raw, "cmd") ?? "";
		const cwd = textField(raw, "cwd");
		return cwd ? { command, cwd } : { command };
	}
	if (kind === "read") return { path: raw.path, offset: raw.offset, limit: raw.limit };
	if (kind === "write") return { path: raw.path, content: raw.content };
	if (kind === "edit") return { path: raw.path, oldText: raw.old_string, newText: raw.new_string, patch: raw.patch };
	if (kind === "grep") return { pattern: raw.pattern, path: raw.path };
	if (kind === "glob") return { path: raw.pattern ?? raw.path };
	return raw;
}

function toolResultBody(payload: JsonObject): JsonObject {
	const result = payload.result;
	return result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject) : {};
}

function toolResultText(payload: JsonObject): string {
	const direct =
		textField(payload, "summary") ??
		textField(payload, "result_text") ??
		(typeof payload.result === "string" ? payload.result : undefined);
	if (direct) return direct;
	const body = toolResultBody(payload);
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
		const rawName = textField(payload, "name") ?? "tool";
		const rawArgs = payload.args && typeof payload.args === "object" && !Array.isArray(payload.args) ? (payload.args as JsonObject) : {};
		const toolName = ompToolName(rawName, rawArgs);
		if (!toolCallId) return [];
		state.tools.set(toolCallId, toolName);
		return [{ type: "tool_execution_start", toolCallId, toolName, args: ompToolArgs(rawName, rawArgs) }];
	}
	if (event.type === "tool.complete") {
		const toolCallId = textField(payload, "tool_id");
		if (!toolCallId) return [];
		const toolName = ompToolName(textField(payload, "name") ?? state.tools.get(toolCallId) ?? "tool");
		state.tools.set(toolCallId, toolName);
		const body = toolResultBody(payload);
		const exitCode = typeof body.exit_code === "number" ? body.exit_code : undefined;
		const wallTimeMs = typeof payload.duration_s === "number" ? Math.round(payload.duration_s * 1000) : undefined;
		return [
			{
				type: "tool_execution_end",
				toolCallId,
				toolName,
				isError: exitCode !== undefined && exitCode !== 0,
				result: {
					content: [{ type: "text", text: toolResultText(payload) }],
					details: { exitCode, wallTimeMs },
				},
			},
		];
	}
	return [];
}

export function interruptRequest(sessionId: string): { session_id: string } {
	return { session_id: sessionId };
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
		await gateway.request("session.interrupt", interruptRequest(sessionId)).catch(() => undefined);
		return originalAbort(options);
	};
	if (process.env.PI_HERMES_REPLAY === "1") replaySessionToolCards(session);
}

const REPLAY_CALLS: Array<{ name: string; args: JsonObject; output: string }> = [
	{ name: "terminal", args: { command: "git status -sb" }, output: "## exp/hermes-tool-cards" },
	{ name: "terminal", args: { command: "bun test test/hermes-interactive-bridge.test.ts" }, output: "1 pass" },
	{ name: "read_file", args: { path: "packages/coding-agent/src/experiments/hermes-interactive-bridge.ts" }, output: "function ompToolName" },
	{ name: "read_file", args: { path: "packages/coding-agent/src/modes/controllers/event-controller.ts", offset: 1806, limit: 40 }, output: "handleToolExecutionStart" },
	{ name: "search_files", args: { pattern: "tool_execution_start", path: "event-controller.ts", target: "content" }, output: "tool_execution_start" },
	{ name: "search_files", args: { pattern: "describeCall", path: "packages/tui/src/tools", target: "content" }, output: "describeCall" },
	{ name: "patch", args: { path: "hermes-interactive-bridge.ts", old_string: "return name;", new_string: "return \"bash\";" }, output: "patched" },
	{ name: "write_file", args: { path: "test/hermes-tool-card-replay.test.ts", content: "replay" }, output: "wrote" },
	{ name: "search_files", args: { pattern: "*.yml", path: ".github/workflows", target: "files" }, output: "ci.yml" },
	{ name: "terminal", args: { command: "ls packages/natives/native" }, output: "loader-state.js" },
	{ name: "read_file", args: { path: "packages/tui/src/tools/bash.ts", offset: 664, limit: 8 }, output: "bashToolRenderer" },
	{ name: "search_files", args: { pattern: "GITNEXUS_LBUG_BUFFER_POOL_SIZE", path: "lbug-config.js", target: "content" }, output: "buffer pool" },
	{ name: "terminal", args: { command: "echo tool-card-ok" }, output: "tool-card-ok" },
	{ name: "read_file", args: { path: "packages/tui/src/theme/theme.ts", offset: 90, limit: 5 }, output: "export var theme" },
	{ name: "search_files", args: { pattern: "renderCall", path: "packages/tui/src/tools/read.ts", target: "content" }, output: "renderCall" },
	{ name: "search_files", args: { pattern: "package.json", target: "files" }, output: "package.json" },
	{ name: "terminal", args: { command: "git log -1 --oneline" }, output: "a9136aef96" },
	{ name: "read_file", args: { path: "packages/tui/src/chat/tool-execution.ts", offset: 974, limit: 20 }, output: "describeTool" },
	{ name: "search_files", args: { pattern: "hasBuiltInTool", path: "session-tools.ts", target: "content" }, output: "hasBuiltInTool" },
	{ name: "shell", args: { command: "gitnexus doctor", cwd: "/tmp" }, output: "VECTOR extension: available" },
	{ name: "terminal", args: { command: "pwd" }, output: "/mnt/zer0models/hermes-wt/omp-hermes-backend" },
];

function replaySessionToolCards(session: AgentSession): void {
	const state: StreamState = { text: "", model: "hermes", started: false, tools: new Map() };
	REPLAY_CALLS.forEach((call, index) => {
		const toolId = `replay-${index + 1}`;
		const start = { type: "tool.start", payload: { tool_id: toolId, name: call.name, args: call.args } };
		const done = {
			type: "tool.complete",
			payload: { tool_id: toolId, name: call.name, args: call.args, result: { output: call.output, exit_code: 0 } },
		};
		for (const event of [start, done]) {
			for (const mapped of hermesEventToSessionEvents(event, state)) session.injectExternalEvent(mapped);
		}
	});
}
