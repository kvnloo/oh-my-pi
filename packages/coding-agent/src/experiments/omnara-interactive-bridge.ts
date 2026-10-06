import type { AssistantMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import { OmnaraClient, type OmnaraSseFrame } from "./omnara-client";

type JsonObject = Record<string, unknown>;

export interface OmnaraInteractiveHost {
	showHookInput(title: string, placeholder?: string): Promise<string | undefined>;
	showHookNotify(message: string, type?: "info" | "warning" | "error"): void;
	showHookSelector(
		title: string,
		options: Array<string | { label: string; description?: string }>,
	): Promise<string | undefined>;
	showStatus(message: string): void;
}

export interface OmnaraBridgeState {
	model: string;
	turnActive: boolean;
	textByContext: Map<string, string>;
	startedContexts: Set<string>;
	toolNames: Map<string, string>;
	startedTools: Set<string>;
	endedTools: Set<string>;
	localInputKeys: Set<string>;
}

export function omnaraBackendEnabled(): boolean {
	return process.env.PI_OMNARA_BACKEND === "1";
}

export function createOmnaraBridgeState(model = "omnara"): OmnaraBridgeState {
	return {
		model,
		turnActive: false,
		textByContext: new Map(),
		startedContexts: new Set(),
		toolNames: new Map(),
		startedTools: new Set(),
		endedTools: new Set(),
		localInputKeys: new Set(),
	};
}

function asObject(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringField(value: unknown, key: string): string | undefined {
	const candidate = asObject(value)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	const candidate = asObject(value)[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function arrayField(value: unknown, key: string): unknown[] {
	const candidate = asObject(value)[key];
	return Array.isArray(candidate) ? candidate : [];
}

function textContent(value: unknown): string {
	return arrayField(value, "content_blocks")
		.map(block => {
			const item = asObject(block);
			const type = stringField(item, "type");
			if (type === "text") return stringField(item, "text") ?? "";
			if (type === "error") return "Error: " + (stringField(item, "text") ?? "unknown model error");
			return "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function assistantStopReason(value: unknown): AssistantMessage["stopReason"] {
	switch (value) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "error":
		case "content_filter":
			return "error";
		default:
			return "stop";
	}
}

function assistantMessage(text: string, model: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "omnara",
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function userMessage(text: string, timestamp?: number): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: timestamp ?? Date.now(),
	};
}

function ensureAssistantStart(
	contextID: string,
	state: OmnaraBridgeState,
	events: AgentSessionEvent[],
): void {
	if (state.startedContexts.has(contextID)) return;
	state.startedContexts.add(contextID);
	events.push({
		type: "message_start",
		message: assistantMessage(state.textByContext.get(contextID) ?? "", state.model),
	});
}

function toolCallsFromModelOutput(payload: unknown): Array<{ id: string; name: string; args: JsonObject }> {
	const calls: Array<{ id: string; name: string; args: JsonObject }> = [];
	for (const block of arrayField(payload, "content_blocks")) {
		const item = asObject(block);
		if (stringField(item, "type") !== "tool_call") continue;
		const id = stringField(item, "tool_call_id");
		const name = stringField(item, "name");
		if (!id || !name) continue;
		calls.push({ id, name, args: asObject(item.input) });
	}
	return calls;
}

function terminalStopReason(stopReason: string | undefined): boolean {
	return (
		stopReason === "end_turn" ||
		stopReason === "refusal" ||
		stopReason === "content_filter" ||
		stopReason === "error"
	);
}

function parseFrame(frame: OmnaraSseFrame): unknown {
	try {
		return JSON.parse(frame.data);
	} catch {
		return undefined;
	}
}

export function omnaraFrameToSessionEvents(
	frame: OmnaraSseFrame,
	state: OmnaraBridgeState,
): AgentSessionEvent[] {
	const payload = parseFrame(frame);
	if (!payload) return [];
	const events: AgentSessionEvent[] = [];

	if (frame.event === "agent_input") {
		if (stringField(payload, "input_kind") !== "content") return [];
		const text = textContent(payload);
		if (!text) return [];
		const key = stringField(payload, "input_idempotency_key");
		if (key) state.localInputKeys.delete(key);
		const createdAt = Date.parse(stringField(payload, "created_at") ?? "");
		const message = userMessage(text, Number.isFinite(createdAt) ? createdAt : undefined);
		return [
			{ type: "message_start", message },
			{ type: "message_end", message },
		];
	}

	if (frame.event === "model_output_delta") {
		const root = asObject(payload);
		const contextID = stringField(root, "model_call_context_id") ?? "model";
		const deltaEvent = asObject(root.event);
		if (stringField(deltaEvent, "kind") !== "text_delta") return [];
		const delta = stringField(deltaEvent, "delta") ?? "";
		if (!delta) return [];
		const next = (state.textByContext.get(contextID) ?? "") + delta;
		state.textByContext.set(contextID, next);
		ensureAssistantStart(contextID, state, events);
		const message = assistantMessage(next, state.model);
		events.push({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: message },
		});
		return events;
	}

	if (frame.event === "model_output") {
		const contextID = stringField(payload, "model_call_context_id") ?? stringField(payload, "id") ?? "model";
		const finalText = textContent(payload);
		if (finalText || !state.textByContext.has(contextID)) state.textByContext.set(contextID, finalText);
		ensureAssistantStart(contextID, state, events);
		const stopReason = stringField(payload, "stop_reason");
		const message = assistantMessage(
			state.textByContext.get(contextID) ?? "",
			state.model,
			assistantStopReason(stopReason),
		);
		events.push({ type: "message_end", message });

		for (const call of toolCallsFromModelOutput(payload)) {
			state.toolNames.set(call.id, call.name);
			if (state.startedTools.has(call.id)) continue;
			state.startedTools.add(call.id);
			events.push({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.args,
			});
		}

		state.startedContexts.delete(contextID);
		state.textByContext.delete(contextID);
		if (terminalStopReason(stopReason)) {
			events.push({ type: "agent_end", messages: [message], isTerminal: true, yielded: true });
			state.turnActive = false;
		}
		return events;
	}

	if (frame.event === "tool_result") {
		const toolCallId = stringField(payload, "tool_call_id");
		if (!toolCallId || state.endedTools.has(toolCallId)) return [];
		state.endedTools.add(toolCallId);
		const outcome = stringField(payload, "outcome");
		const text = textContent(payload) || outcome || "completed";
		return [
			{
				type: "tool_execution_end",
				toolCallId,
				toolName: state.toolNames.get(toolCallId) ?? "tool",
				isError: outcome !== undefined && outcome !== "succeeded",
				result: { content: [{ type: "text", text }] },
			},
		];
	}

	return [];
}

interface OpenInteraction {
	id: string;
	agent_id: string;
	agent_name?: string;
	interaction_kind?: string;
	tool_name?: string;
	request?: {
		title?: string;
		context?: Array<{ label?: string; value?: string }>;
		questions?: Array<{
			prompt?: string;
			multiple?: boolean;
			options?: Array<{ label?: string; allows_text?: boolean }>;
		}>;
	};
}

function interactionTitle(interaction: OpenInteraction): string {
	const title = interaction.request?.title || interaction.tool_name || "Omnara interaction";
	const agent = interaction.agent_name;
	const context = interaction.request?.context
		?.filter(item => item.label || item.value)
		.map(item => (item.label ?? "Context") + ": " + (item.value ?? ""))
		.join("\n");
	return [agent ? title + " · " + agent : title, context].filter(Boolean).join("\n");
}

async function answerInteraction(
	client: OmnaraClient,
	host: OmnaraInteractiveHost,
	interaction: OpenInteraction,
): Promise<"answered" | "dismissed" | "unsupported"> {
	const questions = interaction.request?.questions ?? [];
	const answers: Array<{ option_indices: number[]; text?: string }> = [];

	for (const question of questions) {
		const prompt = question.prompt || interaction.request?.title || "Omnara needs input";
		if (question.multiple) {
			host.showHookNotify("Omnara multi-select interaction left open for this experiment", "warning");
			return "unsupported";
		}

		const options = question.options ?? [];
		if (!options.length) {
			const answer = await host.showHookInput(prompt, "Type your answer");
			if (answer === undefined) return "dismissed";
			answers.push({ option_indices: [], text: answer });
			continue;
		}

		const choices = options.map((option, index) => ({
			label: option.label || "Option " + (index + 1),
			description: option.allows_text ? "May include an optional note" : undefined,
		}));
		const selected = await host.showHookSelector(
			answers.length === 0 ? interactionTitle(interaction) + "\n" + prompt : prompt,
			choices,
		);
		if (selected === undefined) return "dismissed";
		const index = choices.findIndex(choice => choice.label === selected);
		if (index < 0) return "dismissed";

		let text: string | undefined;
		if (options[index]?.allows_text) {
			text = await host.showHookInput("Optional note for " + choices[index]!.label, "Leave blank for none");
			if (text === undefined) text = "";
		}
		answers.push({ option_indices: [index], ...(text ? { text } : {}) });
	}

	await client.resolveInteraction(interaction.agent_id, interaction.id, answers);
	return "answered";
}

function toolSummary(tool: JsonObject): string {
	const state = stringField(tool, "state") ?? "unknown";
	const outcome = stringField(tool, "outcome");
	return outcome ? state + " · " + outcome : state;
}

function injectAll(session: AgentSession, events: readonly AgentSessionEvent[]): void {
	for (const event of events) session.injectExternalEvent(event);
}

export async function attachOmnaraBackend(session: AgentSession, host: OmnaraInteractiveHost): Promise<void> {
	const client = new OmnaraClient();
	const state = createOmnaraBridgeState();
	const abort = new AbortController();
	const dismissedInteractions = new Set<string>();
	let interactionActive = false;
	let refreshScheduled = false;
	let submissionCounter = 0;

	session.addDisposer(() => abort.abort());

	const agentResponse = await client.getAgent<JsonObject>();
	const agent = asObject(agentResponse.agent);
	const model = asObject(agent.model);
	state.model = stringField(model, "name") ?? stringField(model, "id") ?? "omnara";

	const historyResponse = await client.listRecentEvents<JsonObject>(100);
	const history = arrayField(historyResponse, "data")
		.map(event => asObject(event))
		.sort((a, b) => (numberField(a, "sequence") ?? 0) - (numberField(b, "sequence") ?? 0));
	let latestSequence = 0;
	for (const event of history) {
		latestSequence = Math.max(latestSequence, numberField(event, "sequence") ?? 0);
		const kind = stringField(event, "event_kind");
		if (!kind) continue;
		injectAll(
			session,
			omnaraFrameToSessionEvents(
				{
					event: kind,
					id: String(numberField(event, "sequence") ?? ""),
					data: JSON.stringify(event),
				},
				state,
			),
		);
	}

	const refreshTools = async () => {
		const response = await client.listToolCalls<JsonObject>();
		for (const raw of arrayField(response, "data")) {
			const tool = asObject(raw);
			const id = stringField(tool, "id");
			const name = stringField(tool, "name");
			const toolState = stringField(tool, "state");
			if (!id || !name || !toolState) continue;
			state.toolNames.set(id, name);

			if (!state.startedTools.has(id) && toolState !== "completed") {
				state.startedTools.add(id);
				session.injectExternalEvent({
					type: "tool_execution_start",
					toolCallId: id,
					toolName: name,
					args: asObject(tool.input),
				});
			}

			if (toolState === "running" || toolState === "waiting" || toolState === "awaiting_permission") {
				session.injectExternalEvent({
					type: "tool_execution_update",
					toolCallId: id,
					toolName: name,
					args: asObject(tool.input),
					partialResult: { content: [{ type: "text", text: toolSummary(tool) }] },
				});
			}

			if (toolState === "completed" && !state.endedTools.has(id)) {
				state.endedTools.add(id);
				const outcome = stringField(tool, "outcome");
				session.injectExternalEvent({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: name,
					isError: outcome !== undefined && outcome !== "succeeded",
					result: { content: [{ type: "text", text: toolSummary(tool) }] },
				});
			}
		}
	};

	const refreshInteractions = async () => {
		if (interactionActive) return;
		const response = await client.listOpenInteractions<JsonObject>();
		const interaction = arrayField(response, "data")
			.map(item => asObject(item) as unknown as OpenInteraction)
			.find(item => item.id && item.agent_id && !dismissedInteractions.has(item.id));
		if (!interaction) return;

		interactionActive = true;
		try {
			const result = await answerInteraction(client, host, interaction);
			if (result === "answered") {
				host.showHookNotify("Omnara interaction resolved", "info");
			} else {
				dismissedInteractions.add(interaction.id);
			}
		} catch (error) {
			host.showHookNotify("Omnara interaction failed: " + String(error), "error");
		} finally {
			interactionActive = false;
		}
	};

	const refreshAuthoritativeState = async () => {
		await Promise.all([refreshTools(), refreshInteractions()]);
	};

	const scheduleRefresh = () => {
		if (refreshScheduled) return;
		refreshScheduled = true;
		queueMicrotask(() => {
			refreshScheduled = false;
			void refreshAuthoritativeState().catch(error =>
				session.emitNotice("warning", "Omnara refresh failed: " + String(error), "omnara"),
			);
		});
	};

	await refreshAuthoritativeState();

	const originalPrompt = session.prompt.bind(session);
	const originalAbort = session.abort.bind(session);

	session.prompt = async (text, options) => {
		if (text.trimStart().startsWith("/")) return originalPrompt(text, options);
		if (options?.images?.length) throw new Error("Omnara backend experiment does not support image input yet");

		const wasActive = state.turnActive;
		if (!state.turnActive) {
			state.turnActive = true;
			session.injectExternalEvent({ type: "agent_start" });
		}

		const key = "omp-" + Date.now().toString(36) + "-" + (++submissionCounter).toString(36);
		state.localInputKeys.add(key);
		try {
			await client.createInput(
				text,
				key,
				wasActive || options?.streamingBehavior === "steer" ? "steering" : "queued",
			);
			return true;
		} catch (error) {
			state.localInputKeys.delete(key);
			if (!wasActive) {
				state.turnActive = false;
				session.injectExternalEvent({
					type: "agent_end",
					messages: [],
					isTerminal: true,
					yielded: true,
				});
			}
			throw error;
		}
	};

	session.abort = async options => {
		await client.cancel().catch(error => {
			session.emitNotice("warning", "Omnara cancel failed: " + String(error), "omnara");
		});
		return originalAbort(options);
	};

	void (async () => {
		try {
			for await (const frame of client.streamEvents({
				afterSequence: latestSequence,
				signal: abort.signal,
				onConnectionStateChange(connection) {
					if (connection.state === "reconnecting") host.showStatus("Omnara reconnecting…");
					else if (connection.reconnected) scheduleRefresh();
				},
			})) {
				injectAll(session, omnaraFrameToSessionEvents(frame, state));
				if (
					frame.event === "tool_call_update" ||
					frame.event === "tool_result" ||
					frame.event === "agent_input" ||
					frame.event === "model_output"
				) {
					scheduleRefresh();
				}
			}
		} catch (error) {
			if (!abort.signal.aborted) {
				session.emitNotice("error", "Omnara event stream stopped: " + String(error), "omnara");
			}
		}
	})();
}
