import { beforeAll, describe, expect, it } from "bun:test";
import { CollapsedSyntheticMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

describe("collapsed synthetic summary", () => {
	it("keeps a joined emoji intact at the truncation boundary", () => {
		const summary = new CollapsedSyntheticMessageComponent("# abcdef👩‍💻tail\nbody");
		const row = summary.render(11)[0]!;
		expect(Bun.stripANSI(row)).toBe(" abcdef👩‍💻t…");
	});
});
