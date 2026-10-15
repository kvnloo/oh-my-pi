/** IRC arrival must not crash, collapse same-timestamp peers, or repaint after persistence. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Text } from "@oh-my-pi/pi-tui";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

const activeControllers: EventController[] = [];

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(async () => {
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	for (const controller of activeControllers.splice(0)) controller.dispose();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function makeMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content,
		display: true,
		timestamp: 1_765_000_000_000,
	};
}

function makeFixture() {
	const ctx = createInteractiveModeContext();
	let cardId = 0;
	vi.spyOn(ctx, "addMessageToChat").mockImplementation(() => {
		const component = new Text(`IRC_CARD_${++cardId}`, 0, 0);
		ctx.chatContainer.addChild(component);
		return [component];
	});
	const controller = new EventController(ctx);
	activeControllers.push(controller);
	const deliver = (message: CustomMessage) =>
		controller.handleEvent({ type: "irc_message", message } satisfies Extract<AgentSessionEvent, { type: "irc_message" }>);
	const visibleCards = () => ctx.chatContainer.render(120).filter(line => line.includes("IRC_CARD_")).length;
	return { controller, deliver, visibleCards };
}

describe("IRC message rendering", () => {
	it("displays both messages when two peers share the same millisecond timestamp", async () => {
		const { deliver, visibleCards } = makeFixture();
		await deliver(makeMessage("peer 1"));
		await deliver(makeMessage("peer 2"));
		expect(visibleCards()).toBe(2);
	});

	it("does not repaint a repeated IRC delivery or its later persisted message_start", async () => {
		const { controller, deliver, visibleCards } = makeFixture();
		const message = makeMessage("same delivery");
		await deliver(message);
		await deliver(message);
		await controller.handleEvent({ type: "message_start", message });
		expect(visibleCards()).toBe(1);
	});
});
