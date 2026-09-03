import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { randomUUID } from "node:crypto";
import type { LiveSessionControllerOptions } from "../../live/controller";
import type { AgentSession } from "../../session/agent-session";
import type { SttControllerOptions, SttEditor } from "../../stt/stt-controller";
import type { RpcVoiceEvent, RpcVoiceMode, RpcVoiceState } from "./rpc-types";

type Output = (event: RpcVoiceEvent) => void;
type VoiceEventBody = RpcVoiceEvent extends infer Event
	? Event extends RpcVoiceEvent
		? Omit<Event, "voiceSessionId" | "mode">
		: never
	: never;
export interface RpcLiveSession {
	readonly phase: string;
	readonly muted: boolean;
	start(): Promise<void>;
	toggleMute(): void;
	stop(): Promise<void>;
}

export interface RpcSttSession {
	readonly state: string;
	start(editor: SttEditor, options: SttControllerOptions): Promise<void>;
	stop(options: SttControllerOptions): Promise<string>;
	cancel(options: SttControllerOptions): void;
}

type LiveFactory = (options: LiveSessionControllerOptions) => RpcLiveSession;

function assistantText(message: AssistantMessage): string {
	return message.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("");
}

/** Owns the single microphone surface for one RPC process. */
export class RpcVoiceController {
	readonly #session: AgentSession;
	readonly #output: Output;
	readonly #stt: RpcSttSession;
	readonly #createLive: LiveFactory;
	readonly #liveVoice: () => string | undefined;
	#mode: RpcVoiceMode | undefined;
	#voiceSessionId: string | undefined;
	#startedAt = 0;
	#live: RpcLiveSession | undefined;
	#terminal = false;
	#requestedOutcome: "stopped" | "cancelled" = "stopped";
	#dictationError: Error | undefined;
	#dictationText = "";
	#deferDictationIdle = false;
	constructor(
		session: AgentSession,
		output: Output,
		stt: RpcSttSession,
		createLive: LiveFactory,
		liveVoice: () => string | undefined,
	) {
		this.#session = session;
		this.#output = output;
		this.#stt = stt;
		this.#createLive = createLive;
		this.#liveVoice = liveVoice;
	}

	get active(): boolean {
		return this.#mode !== undefined;
	}

	async startDictation(): Promise<RpcVoiceState> {
		this.#claim("dictation");
		const options = this.#sttOptions();
		try {
			await this.#stt.start(this.#dictationEditor(), options);
			if (this.#dictationError) throw this.#dictationError;
			if (this.#stt.state !== "recording") throw new Error("Dictation could not start");
			return this.#state("recording");
		} catch (cause) {
			this.#fail(cause);
			throw cause;
		}
	}

	async stopDictation(): Promise<RpcVoiceState> {
		this.#require("dictation");
		this.#deferDictationIdle = true;
		try {
			await this.#stt.stop(this.#sttOptions());
			if (this.#dictationError) throw this.#dictationError;
			this.#emit({ type: "voice_transcript", role: "user", text: this.#dictationText, final: true, turn: 1 });
			const state = this.#state("idle");
			this.#emitState("idle");
			this.#finish("stopped");
			return state;
		} catch (cause) {
			this.#fail(cause);
			throw cause;
		} finally {
			this.#deferDictationIdle = false;
		}
	}

	cancelDictation(): RpcVoiceState {
		this.#require("dictation");
		this.#stt.cancel(this.#sttOptions());
		const state = this.#state("idle");
		this.#finish("cancelled");
		return state;
	}

	async startLive(): Promise<RpcVoiceState> {
		this.#claim("live");
		const voiceSessionId = this.#voiceSessionId!;
		let live!: RpcLiveSession;
		live = this.#createLive({
			session: this.#session,
			extractAssistantText: assistantText,
			voice: this.#liveVoice(),
			callbacks: {
				onPhase: phase => {
					if (this.#voiceSessionId === voiceSessionId) this.#emitState(phase, live?.muted ?? false);
				},
				onLevels: (input, output) => this.#emit({ type: "voice_level", input, output, elapsedMs: this.#elapsed() }),
				onTranscript: transcript => {
					if (transcript)
						this.#emit({
							type: "voice_transcript",
							role: transcript.role,
							text: transcript.text,
							final: transcript.final,
							turn: transcript.turn,
						});
				},
				onTerminal: error => {
					if (error) this.#finish("error", error.message);
					else this.#finish(this.#requestedOutcome);
				},
			},
		});
		this.#live = live;
		try {
			await live.start();
			return this.#state(live.phase, live.muted);
		} catch (cause) {
			this.#fail(cause);
			throw cause;
		}
	}

	toggleLiveMute(): RpcVoiceState {
		this.#require("live");
		this.#live!.toggleMute();
		const state = this.#state(this.#live!.phase, this.#live!.muted);
		this.#emitState(state.phase, state.muted);
		return state;
	}

	async stopLive(): Promise<RpcVoiceState> {
		this.#require("live");
		this.#requestedOutcome = "stopped";
		const live = this.#live!;
		await live.stop();
		return { mode: "live", phase: "idle", muted: live.muted };
	}

	async stopActive(outcome: "cancelled" | "stopped" = "cancelled"): Promise<void> {
		if (this.#mode === "dictation") {
			this.#stt.cancel(this.#sttOptions());
			this.#finish(outcome);
		} else if (this.#mode === "live") {
			this.#requestedOutcome = outcome;
			await this.#live?.stop();
		}
	}

	#claim(mode: RpcVoiceMode): void {
		if (this.#mode) throw new Error(`Microphone is already owned by ${this.#mode}`);
		this.#mode = mode;
		this.#voiceSessionId = randomUUID();
		this.#startedAt = Date.now();
		this.#terminal = false;
		this.#requestedOutcome = "stopped";
		this.#dictationError = undefined;
		this.#dictationText = "";
		this.#deferDictationIdle = false;
	}

	#require(mode: RpcVoiceMode): void {
		if (this.#mode !== mode)
			throw new Error(this.#mode ? `Microphone is owned by ${this.#mode}` : `No ${mode} session is active`);
	}

	#dictationEditor(): SttEditor {
		return {
			insertText: text => {
				this.#dictationText += text;
			},
			setVolatileText: () => {},
			clearVolatileText: () => {},
			commitVolatileText: text => {
				this.#dictationText += text;
			},
			submit: () => {},
			deleteBeforeCursor: count => {
				this.#dictationText = this.#dictationText.slice(0, -count);
			},
		};
	}

	#sttOptions(): SttControllerOptions {
		return {
			showWarning: message => {
				this.#dictationError = new Error(message);
				this.#fail(this.#dictationError);
			},
			showStatus: () => {},
			onStateChange: phase => {
				if (phase !== "idle" || !this.#deferDictationIdle) this.#emitState(phase);
			},
			onTranscript: (text, final) => {
				if (!final) this.#emit({ type: "voice_transcript", role: "user", text, final: false, turn: 1 });
			},
			onLevel: input => this.#emit({ type: "voice_level", input, output: 0, elapsedMs: this.#elapsed() }),
		};
	}

	#state(phase: string, muted?: boolean): RpcVoiceState {
		return { mode: this.#mode!, phase, ...(muted === undefined ? {} : { muted }) };
	}
	#emitState(phase: string, muted?: boolean): void {
		this.#emit({ type: "voice_state", phase, ...(muted === undefined ? {} : { muted }), elapsedMs: this.#elapsed() });
	}

	#emit(event: VoiceEventBody): void {
		if (!this.#mode || !this.#voiceSessionId || this.#terminal) return;
		this.#output({ ...event, voiceSessionId: this.#voiceSessionId, mode: this.#mode } as RpcVoiceEvent);
	}

	#fail(cause: unknown): void {
		this.#finish("error", cause instanceof Error ? cause.message : String(cause));
	}

	#finish(outcome: "stopped" | "cancelled" | "error", error?: string): void {
		if (!this.#mode || !this.#voiceSessionId || this.#terminal) return;
		this.#terminal = true;
		this.#output({
			type: "voice_terminal",
			voiceSessionId: this.#voiceSessionId,
			mode: this.#mode,
			outcome,
			elapsedMs: this.#elapsed(),
			...(error ? { error } : {}),
		});
		this.#mode = undefined;
		this.#voiceSessionId = undefined;
		this.#live = undefined;
	}

	#elapsed(): number {
		return Math.max(0, Date.now() - this.#startedAt);
	}
}
