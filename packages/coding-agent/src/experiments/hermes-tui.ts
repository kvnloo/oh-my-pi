import { Markdown, Text } from "@oh-my-pi/pi-tui";
import { ChatBlock } from "@oh-my-pi/pi-tui/chrome/chat-block";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { getMarkdownTheme } from "@oh-my-pi/pi-tui/theme";

import { HermesGatewayClient, type HermesGatewayEvent } from "./hermes-gateway";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function textField(value: unknown, key: string): string | undefined {
	const candidate = asObject(value)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
	const candidate = asObject(value)[key];
	return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

class HermesAssistantBlock extends ChatBlock {
	#markdown = new Markdown("", 1, 1, getMarkdownTheme());
	#text = "";

	constructor() {
		super();
		this.#markdown.transientRenderCache = true;
		this.addChild(this.#markdown);
	}

	get text(): string {
		return this.#text;
	}

	append(delta: string): void {
		if (!delta) return;
		this.#text += delta;
		this.#markdown.setText(this.#text);
		this.requestRender();
	}

	complete(finalText?: string): void {
		if (finalText !== undefined && finalText !== this.#text) {
			this.#text = finalText;
			this.#markdown.setText(finalText);
		}
		this.#markdown.transientRenderCache = false;
		this.finish();
	}
}

class HermesActivityBlock extends ChatBlock {
	#line: Text;

	constructor(text: string) {
		super();
		this.#line = new Text(text, 1, 0);
		this.addChild(this.#line);
	}

	update(text: string): void {
		if (this.#line.setText(text)) this.requestRender();
	}

	complete(text: string): void {
		this.#line.setText(text);
		this.finish();
	}
}

interface SessionInfo {
	model?: string;
	reasoning_effort?: string;
	running?: boolean;
}

interface SessionCreateResult {
	info?: SessionInfo;
	session_id?: string;
	stored_session_id?: string;
}

const composer = new Composer({
	welcome: { version: "Hermes backend experiment" },
});
const transcript = new TranscriptContainer();
const status = new Text("Hermes backend · connecting…", 1, 0);
const gateway = new HermesGatewayClient();

let activeAssistant: HermesAssistantBlock | undefined;
let running = false;
let sessionId: string | undefined;
let storedSessionId: string | undefined;
let sessionInfo: SessionInfo = {};
let shuttingDown = false;
const tools = new Map<string, HermesActivityBlock>();
const subagents = new Map<string, HermesActivityBlock>();

const editor = composer.editor;
editor.disableSubmit = true;
editor.placeholder = () => (sessionId ? "Message Hermes" : "Connecting to Hermes…");
editor.composerState = () => ({
	running,
	thinking: sessionInfo.reasoning_effort,
});

composer.setRuntimeChildren([transcript, status, editor], {
	nativeDock: [status, editor],
	transient: [editor],
});

const host = {
	requestRender: () => composer.ui.requestRender(),
};

function repaint(): void {
	composer.ui.requestRender();
}

function setRunning(next: boolean): void {
	running = next;
	editor.disableSubmit = next || !sessionId;
	repaint();
}

function setStatus(text: string): void {
	status.setText(text);
	repaint();
}

function appendStatic(text: string): void {
	if (!text.trim()) return;
	transcript.addChild(new Text(text, 1, 0));
	repaint();
}

function mountBlock<T extends ChatBlock>(block: T): T {
	transcript.addChild(block);
	block.mount(host);
	repaint();
	return block;
}

function ensureAssistant(): HermesAssistantBlock {
	if (activeAssistant) return activeAssistant;
	activeAssistant = mountBlock(new HermesAssistantBlock());
	return activeAssistant;
}

function finishAssistant(finalText?: string): void {
	const block = ensureAssistant();
	block.complete(finalText);
	activeAssistant = undefined;
}

function formatToolStart(payload: unknown): string {
	const name = textField(payload, "name") ?? "tool";
	const context = textField(payload, "context")?.trim();
	return context ? "tool · " + name + " · " + context : "tool · " + name;
}

function formatToolComplete(payload: unknown): string {
	const name = textField(payload, "name") ?? "tool";
	const summary = textField(payload, "summary")?.trim() || textField(payload, "result_text")?.trim();
	const duration = numberField(payload, "duration_s");
	const tail = [summary, duration === undefined ? undefined : duration.toFixed(1) + "s"].filter(Boolean).join(" · ");
	return tail ? "tool · " + name + " · " + tail : "tool · " + name + " · complete";
}

function subagentKey(payload: unknown): string {
	return (
		textField(payload, "subagent_id") ||
		textField(payload, "child_session_id") ||
		textField(payload, "delegation_id") ||
		(textField(payload, "goal") ?? "subagent") + ":" + String(numberField(payload, "task_index") ?? 0)
	);
}

function formatSubagent(payload: unknown, fallbackStatus: string): string {
	const goal = textField(payload, "goal") ?? "delegated task";
	const state = textField(payload, "status") ?? fallbackStatus;
	const model = textField(payload, "model");
	const tool = textField(payload, "tool_name");
	const detail = tool ? " · " + tool : model ? " · " + model : "";
	return "agent · " + state + " · " + goal + detail;
}

function eventBelongsHere(event: HermesGatewayEvent): boolean {
	return !event.session_id || !sessionId || event.session_id === sessionId;
}

function onEvent(event: HermesGatewayEvent): void {
	if (!eventBelongsHere(event)) return;
	const payload = event.payload ?? {};

	switch (event.type) {
		case "message.start":
			setRunning(true);
			ensureAssistant();
			setStatus("Hermes backend · running");
			return;
		case "message.delta": {
			const delta = textField(payload, "text");
			if (delta) ensureAssistant().append(delta);
			return;
		}
		case "message.interim": {
			const text = textField(payload, "text");
			if (text?.trim()) {
				const block = mountBlock(new HermesAssistantBlock());
				block.append(text);
				block.complete();
			}
			return;
		}
		case "message.complete": {
			const finalText = textField(payload, "text");
			finishAssistant(finalText);
			setRunning(false);
			const turnStatus = textField(payload, "status") ?? "complete";
			setStatus("Hermes backend · " + (turnStatus === "complete" ? "ready" : turnStatus));
			const warning = textField(payload, "warning");
			if (warning) appendStatic("Hermes warning · " + warning);
			return;
		}
		case "tool.start": {
			const id = textField(payload, "tool_id");
			if (!id) return;
			const block = mountBlock(new HermesActivityBlock(formatToolStart(payload)));
			tools.set(id, block);
			return;
		}
		case "tool.complete": {
			const id = textField(payload, "tool_id");
			if (!id) return;
			const block = tools.get(id);
			if (block) {
				block.complete(formatToolComplete(payload));
				tools.delete(id);
			} else {
				const late = mountBlock(new HermesActivityBlock(formatToolComplete(payload)));
				late.finish();
			}
			return;
		}
		case "subagent.spawn_requested":
		case "subagent.start":
		case "subagent.progress":
		case "subagent.thinking":
		case "subagent.tool": {
			const id = subagentKey(payload);
			const fallback = event.type === "subagent.spawn_requested" ? "queued" : "running";
			let block = subagents.get(id);
			if (!block) {
				block = mountBlock(new HermesActivityBlock(formatSubagent(payload, fallback)));
				subagents.set(id, block);
			} else {
				block.update(formatSubagent(payload, fallback));
			}
			return;
		}
		case "subagent.complete": {
			const id = subagentKey(payload);
			const block = subagents.get(id);
			const line = formatSubagent(payload, "completed");
			if (block) {
				block.complete(line);
				subagents.delete(id);
			} else {
				const late = mountBlock(new HermesActivityBlock(line));
				late.finish();
			}
			return;
		}
		case "session.info": {
			sessionInfo = { ...sessionInfo, ...payload } as SessionInfo;
			if (typeof sessionInfo.running === "boolean") setRunning(sessionInfo.running);
			repaint();
			return;
		}
		case "status.update": {
			const next = textField(payload, "text");
			if (next) setStatus("Hermes backend · " + next);
			return;
		}
		case "error": {
			const message = textField(payload, "message") ?? "unknown gateway error";
			setRunning(false);
			if (activeAssistant && !activeAssistant.text) {
				activeAssistant.complete();
				activeAssistant = undefined;
			}
			appendStatic("Hermes error · " + message);
			setStatus("Hermes backend · error");
			return;
		}
	}
}

async function submit(text: string): Promise<void> {
	const prompt = text.trim();
	if (!prompt || !sessionId || running) return;

	transcript.addChild(new UserMessageComponent(text, { timestamp: Date.now() }));
	setRunning(true);
	setStatus("Hermes backend · submitting…");

	try {
		await gateway.request("prompt.submit", {
			session_id: sessionId,
			surface: "tui",
			text,
		});
	} catch (error) {
		setRunning(false);
		appendStatic("Hermes submit failed · " + (error instanceof Error ? error.message : String(error)));
		setStatus("Hermes backend · ready");
	}
}

function shutdown(code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	gateway.close();
	composer.stop();
	process.exit(code);
}

editor.onSubmit = submit;
editor.onEscape = () => {
	if (!running || !sessionId) return;
	void gateway
		.request("session.interrupt", { session_id: sessionId })
		.catch(error => appendStatic("Hermes interrupt failed · " + String(error)));
};
editor.onExit = () => shutdown(0);

gateway.on("event", onEvent);
gateway.on("serverRequestDeclined", method => {
	appendStatic("Hermes safety prompt declined by experiment · " + String(method));
});
gateway.on("protocolError", error => {
	appendStatic("Hermes protocol error · " + String(error));
});
gateway.on("error", error => {
	running = false;
	appendStatic("Hermes gateway error · " + String(error));
	setStatus("Hermes backend · disconnected");
});
gateway.on("exit", code => {
	if (shuttingDown) return;
	running = false;
	editor.disableSubmit = true;
	appendStatic("Hermes gateway exited · " + String(code ?? "unknown"));
	setStatus("Hermes backend · disconnected");
});

process.once("SIGTERM", () => shutdown(143));
process.once("SIGHUP", () => shutdown(129));

composer.start({ playWelcomeIntro: false });
gateway.start();

try {
	await gateway.waitReady();
	await gateway.request("client.capabilities", { server_requests: false });

	const cwd = process.env.HERMES_CWD?.trim() || process.cwd();
	const created = await gateway.request<SessionCreateResult>("session.create", {
		close_on_disconnect: true,
		cols: process.stdout.columns ?? 80,
		cwd,
		cwd_explicit: Boolean(process.env.HERMES_CWD?.trim()),
		model: process.env.HERMES_MODEL?.trim() || undefined,
		profile: process.env.HERMES_PROFILE?.trim() || undefined,
		source: "omp-hermes-experiment",
	});

	if (!created.session_id) throw new Error("session.create returned no session_id");
	sessionId = created.session_id;
	storedSessionId = created.stored_session_id;
	sessionInfo = created.info ?? {};
	setRunning(false);
	setStatus(
		"Hermes backend · ready" +
			(sessionInfo.model ? " · " + sessionInfo.model : "") +
			(storedSessionId ? " · " + storedSessionId : ""),
	);
	repaint();
} catch (error) {
	editor.disableSubmit = true;
	appendStatic(
		"Hermes startup failed · " +
			(error instanceof Error ? error.message : String(error)) +
			" · set HERMES_ROOT/HERMES_PYTHON_SRC_ROOT if tui_gateway is not installed",
	);
	setStatus("Hermes backend · startup failed");
}
