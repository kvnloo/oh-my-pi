import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings, settings } from "../src/config/settings";
import * as asrClient from "../src/stt/asr-client";
import * as downloader from "../src/stt/downloader";
import { STTController } from "../src/stt/stt-controller";
import { evaluateSubmitTrigger, type SttSubmitTrigger } from "../src/stt/submit-trigger";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("STT Submit Trigger Evaluation", () => {
	describe("never trigger", () => {
		it("should never submit", () => {
			expect(evaluateSubmitTrigger("hello world", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("submit", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "never")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release trigger", () => {
		it("should only submit if utterance has 2+ words", () => {
			expect(evaluateSubmitTrigger("hello", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("  hello  ", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world!", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("one two three", "release")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("release-complete trigger", () => {
		it("should submit only if utterance ends with terminal punctuation", () => {
			expect(evaluateSubmitTrigger("hello", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello world", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello.", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello?", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello!", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello...", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			// Full-width punctuation
			expect(evaluateSubmitTrigger("hello。", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello？", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello！", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello…", "release-complete")).toEqual({
				submit: true,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "release-complete")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});

	describe("say-submit trigger", () => {
		it("should submit and trim trailing word when last word contains submit", () => {
			// Single word
			expect(evaluateSubmitTrigger("submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("SUBMIT", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 6,
			});
			expect(evaluateSubmitTrigger("submit!", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7,
			});

			// Multi word
			expect(evaluateSubmitTrigger("please submit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 7, // " submit" has length 7
			});
			expect(evaluateSubmitTrigger("please submit.", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8, // " submit." has length 8
			});
			expect(evaluateSubmitTrigger("please submit?", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 8,
			});
			expect(evaluateSubmitTrigger("please submit  ", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 9, // " submit  " has length 9
			});

			// Word containing submit
			expect(evaluateSubmitTrigger("please autosubmit", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11, // " autosubmit" has length 11
			});
			expect(evaluateSubmitTrigger("please submitting", "say-submit")).toEqual({
				submit: true,
				trimTrailing: 11,
			});

			// Negative cases
			expect(evaluateSubmitTrigger("submit please", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("hello", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
			expect(evaluateSubmitTrigger("", "say-submit")).toEqual({
				submit: false,
				trimTrailing: 0,
			});
		});
	});
});

describe("STTController submit trigger integration", () => {
	let state: SettingsTestState | undefined;
	let controller: STTController | undefined;

	function makeEditor(preceding = "") {
		return {
			insertText: vi.fn(),
			setVolatileText: vi.fn(),
			clearVolatileText: vi.fn(),
			commitVolatileText: vi.fn(),
			submit: vi.fn(),
			deleteBeforeCursor: vi.fn(),
			getCharBeforeCursor: vi.fn().mockReturnValue(preceding),
		};
	}

	function makeOptions() {
		return {
			showWarning: vi.fn(),
			showStatus: vi.fn(),
			onStateChange: vi.fn(),
			requestRender: vi.fn(),
		};
	}

	async function transcribeStream(transcript: string, trigger: SttSubmitTrigger, preceding = "") {
		settings.set("stt.submitTrigger", trigger);
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue(transcript),
			cancel: vi.fn(),
		});
		const editor = makeEditor(preceding);
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");

		return { editor, options };
	}

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
	});

	afterEach(() => {
		controller?.dispose();
		controller = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	it("submits streaming dictation on release when the transcript has at least two words", async () => {
		const { editor } = await transcribeStream("hello world", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("does not submit one-word streaming dictation on release", async () => {
		const { editor } = await transcribeStream("hello", "release");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("strips the spoken submit command before submitting streaming dictation", async () => {
		const { editor } = await transcribeStream("please review this submit.", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("please review this submit.");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(8);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("submits the existing draft when streaming dictation only says submit", async () => {
		const { editor } = await transcribeStream("submit", "say-submit");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("submit");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(6);
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("keeps the empty-editor first phrase unprefixed (regression guard)", async () => {
		const { editor } = await transcribeStream("hello world", "release", "");

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
	});

	it("prefixes the live volatile preview with a leading space when preceded by non-whitespace", async () => {
		settings.set("stt.submitTrigger", "never");
		let onPartial: ((text: string) => void) | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_key, opts) => {
			onPartial = opts?.onPartial;
			return { pushAudio: vi.fn(), stop: vi.fn().mockResolvedValue(""), cancel: vi.fn() };
		});
		const editor = makeEditor("g");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		onPartial!("hello world");
		expect(editor.setVolatileText).toHaveBeenCalledWith(" hello world");
		onPartial!("hello world again");
		expect(editor.setVolatileText).toHaveBeenLastCalledWith(" hello world again");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");
	});

	it("separates the first finalized segment from preceding draft text during streaming", async () => {
		settings.set("stt.submitTrigger", "never");
		let onSegment: ((text: string, index: number) => void) | undefined;
		vi.spyOn(asrClient.sttClient, "startStream").mockImplementation((_key, opts) => {
			onSegment = opts?.onSegment;
			return { pushAudio: vi.fn(), stop: vi.fn().mockResolvedValue(""), cancel: vi.fn() };
		});
		const editor = makeStatefulEditor("fix the bug");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		onSegment!("hello world", 0);
		expect(editor.commitVolatileText).toHaveBeenCalledWith(" hello world");
		expect(editor.getText()).toBe("fix the bug hello world");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");
		// No further final text on stop, so the committed segment stays separated.
		expect(editor.getText()).toBe("fix the bug hello world");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("leaves the separated first phrase in the composer without submitting (never trigger)", async () => {
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello world"),
			cancel: vi.fn(),
		});
		const editor = makeStatefulEditor("fix the bug");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		expect(controller.state).toBe("recording");
		await controller.toggle(editor, options);
		expect(controller.state).toBe("idle");

		expect(editor.commitVolatileText).toHaveBeenCalledWith(" hello world");
		expect(editor.getText()).toBe("fix the bug hello world");
		expect(editor.submit).not.toHaveBeenCalled();
	});

	it("submits the separated buffer on release (release trigger)", async () => {
		settings.set("stt.submitTrigger", "release");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello world"),
			cancel: vi.fn(),
		});
		const editor = makeStatefulEditor("fix the bug");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		await controller.toggle(editor, options);

		expect(editor.getText()).toBe("fix the bug hello world");
		expect(editor.submit).toHaveBeenCalledTimes(1);
		expect(editor.getSubmitted()).toBe("fix the bug hello world");
	});

	it("preserves the seam space after trimming the spoken submit command (say-submit trigger)", async () => {
		settings.set("stt.submitTrigger", "say-submit");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("please review this submit."),
			cancel: vi.fn(),
		});
		const editor = makeStatefulEditor("fix the bug");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		await controller.toggle(editor, options);

		expect(editor.commitVolatileText).toHaveBeenCalledWith(" please review this submit.");
		expect(editor.deleteBeforeCursor).toHaveBeenCalledWith(8);
		expect(editor.getText()).toBe("fix the bug please review this");
		expect(editor.submit).toHaveBeenCalledTimes(1);
		expect(editor.getSubmitted()).toBe("fix the bug please review this");
	});

	it("does not double an existing trailing space before the first phrase", async () => {
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello world"),
			cancel: vi.fn(),
		});
		const editor = makeStatefulEditor("fix the bug ");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		await controller.toggle(editor, options);

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.getText()).toBe("fix the bug hello world");
	});

	it("does not prefix a leading space at the start of a fresh line", async () => {
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(asrClient.sttClient, "startStream").mockReturnValue({
			pushAudio: vi.fn(),
			stop: vi.fn().mockResolvedValue("hello world"),
			cancel: vi.fn(),
		});
		const editor = makeStatefulEditor("fix the bug\n");
		const options = makeOptions();
		controller = new STTController(() => ({ stop: vi.fn() }));

		await controller.toggle(editor, options);
		await controller.toggle(editor, options);

		expect(editor.commitVolatileText).toHaveBeenCalledWith("hello world");
		expect(editor.getText()).toBe("fix the bug\nhello world");
	});
});

/** A stateful editor fake that splices text into a real buffer (mirroring the real Editor's
 *  volatile/commit inserters), so the seam between existing draft and dictated text can be
 *  observed end-to-end through the real STTController.toggle. Exposes getText() for the
 *  resulting buffer and getSubmitted() for the message handed to submit(). */
function makeStatefulEditor(initial = "") {
	let text = initial;
	let cursor = initial.length;
	let volatileLen = 0;
	let submitted: string | undefined;
	const insert = (t: string): void => {
		text = text.slice(0, cursor) + t + text.slice(cursor);
		cursor += t.length;
	};
	const deleteBefore = (n: number): void => {
		const removable = Math.min(n, cursor);
		text = text.slice(0, cursor - removable) + text.slice(cursor);
		cursor -= removable;
	};
	const fns = {
		insertText: vi.fn((t: string) => insert(t)),
		setVolatileText: vi.fn((t: string) => {
			deleteBefore(volatileLen);
			insert(t);
			volatileLen = t.length;
		}),
		clearVolatileText: vi.fn(() => {
			deleteBefore(volatileLen);
			volatileLen = 0;
		}),
		commitVolatileText: vi.fn((t: string) => {
			deleteBefore(volatileLen);
			volatileLen = 0;
			if (t) insert(t);
		}),
		submit: vi.fn(() => {
			submitted = text;
		}),
		deleteBeforeCursor: vi.fn((n: number) => deleteBefore(n)),
		getCharBeforeCursor: vi.fn(() => (cursor > 0 ? text.slice(cursor - 1, cursor) : "")),
	};
	return Object.assign(fns, {
		getText: (): string => text,
		getSubmitted: (): string | undefined => submitted,
	});
}
