import { describe, expect, it } from "bun:test";
import type { LiveSessionControllerOptions } from "@oh-my-pi/pi-coding-agent/live/controller";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	RpcVoiceController,
	type RpcLiveSession,
	type RpcSttSession,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-voice";
import type { SttControllerOptions, SttEditor } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";
import type { RpcVoiceEvent } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

class FakeStt implements RpcSttSession {
	state = "idle";
	options: SttControllerOptions | undefined;
	editor: SttEditor | undefined;

	async start(editor: SttEditor, options: SttControllerOptions): Promise<void> {
		this.editor = editor;
		this.options = options;
		this.state = "recording";
		options.onStateChange("recording");
	}

	async stop(options: SttControllerOptions): Promise<string> {
		this.state = "transcribing";
		options.onStateChange("transcribing");
		this.editor?.commitVolatileText("hello");
		options.onTranscript?.("hello", true);
		this.state = "idle";
		options.onStateChange("idle");
		return "hello";
	}

	cancel(options: SttControllerOptions): void {
		this.state = "idle";
		options.onStateChange("idle");
	}
}

class FailingStopStt extends FakeStt {
	override async stop(options: SttControllerOptions): Promise<string> {
		this.state = "transcribing";
		options.onStateChange("transcribing");
		options.showWarning("transcription failed");
		this.state = "idle";
		options.onStateChange("idle");
		return "";
	}
}

class FakeLive implements RpcLiveSession {
	phase = "listening";
	muted = false;
	stopCalls = 0;
	readonly options: LiveSessionControllerOptions;

	constructor(options: LiveSessionControllerOptions) {
		this.options = options;
	}

	async start(): Promise<void> {
		this.options.callbacks.onPhase("listening");
	}

	toggleMute(): void {
		this.muted = !this.muted;
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.options.callbacks.onTerminal();
	}
}

const session = {} as AgentSession;

function harness(stt = new FakeStt()) {
	const events: RpcVoiceEvent[] = [];
	let live: FakeLive | undefined;
	const controller = new RpcVoiceController(
		session,
		event => events.push(event),
		stt,
		options => {
			live = new FakeLive(options);
			return live;
		},
		() => undefined,
	);
	return {
		controller,
		events,
		stt,
		get live() {
			return live;
		},
	};
}

describe("RpcVoiceController", () => {
	it("enforces one microphone owner across dictation and live", async () => {
		const test = harness();
		await test.controller.startDictation();
		await expect(test.controller.startLive()).rejects.toThrow("Microphone is already owned by dictation");
		test.controller.cancelDictation();
		await test.controller.startLive();
		await expect(test.controller.startDictation()).rejects.toThrow("Microphone is already owned by live");
	});

	it("streams dictation state, transcript, level, and one terminal", async () => {
		const test = harness();
		await test.controller.startDictation();
		test.stt.options?.onTranscript?.("hel", false);
		test.stt.options?.onLevel?.(0.4);
		await test.controller.stopDictation();

		expect(
			test.events
				.filter(event => event.type === "voice_state" || event.type === "voice_transcript")
				.map(event => (event.type === "voice_state" ? ["state", event.phase] : ["transcript", event.text, event.final])),
		).toEqual([
			["state", "recording"],
			["transcript", "hel", false],
			["state", "transcribing"],
			["transcript", "hello", true],
			["state", "idle"],
		]);
		expect(test.events.filter(event => event.type === "voice_level")).toHaveLength(1);
		expect(test.events.filter(event => event.type === "voice_terminal")).toHaveLength(1);
	});

	it("does not emit a committed transcript when dictation is cancelled", async () => {
		const test = harness();
		await test.controller.startDictation();
		test.stt.options?.onTranscript?.("uncommitted", false);
		const transcriptsBeforeCancel = test.events.filter(event => event.type === "voice_transcript");

		test.controller.cancelDictation();

		expect(test.events.filter(event => event.type === "voice_transcript")).toEqual(transcriptsBeforeCancel);
		expect(test.events.filter(event => event.type === "voice_terminal")).toHaveLength(1);
	});

	it("rejects a failed dictation stop after emitting exactly one error terminal", async () => {
		const test = harness(new FailingStopStt());
		await test.controller.startDictation();

		await expect(test.controller.stopDictation()).rejects.toThrow("transcription failed");
		const terminals = test.events.filter(event => event.type === "voice_terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ outcome: "error", error: "transcription failed", mode: "dictation" });
		expect(test.controller.active).toBe(false);
	});

	it("emits exactly one terminal when cleanup and controller terminal race", async () => {
		const test = harness();
		await test.controller.startLive();
		await test.controller.stopActive();
		test.live?.options.callbacks.onTerminal(new Error("late failure"));
		await test.controller.stopActive();

		const terminals = test.events.filter(event => event.type === "voice_terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]?.outcome).toBe("cancelled");
		expect(test.live?.stopCalls).toBe(1);
	});

	it("reports live mute state and terminal error once", async () => {
		const test = harness();
		await test.controller.startLive();
		const state = test.controller.toggleLiveMute();
		expect(state.muted).toBe(true);
		test.live?.options.callbacks.onTerminal(new Error("transport failed"));
		test.live?.options.callbacks.onTerminal(new Error("duplicate"));

		const terminals = test.events.filter(event => event.type === "voice_terminal");
		expect(terminals).toHaveLength(1);
		expect(terminals[0]).toMatchObject({ outcome: "error", error: "transport failed" });
	});
});
