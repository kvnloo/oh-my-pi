import { describe, expect, it } from "bun:test";
import { dispatchDragMouseSequence, type DragMouse } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

// Regression coverage for the stuck-button failure mode: `#drag` used to run
// `mouse.down()` followed by `mouse.move(end, { steps: 12 })` and `mouse.up()`
// on the linear success path only. If anything between `down()` and `up()`
// rejected (user cancel, per-op `actionOpMs` timeout, or a CDP error mid-drag),
// puppeteer's per-`Page` `CdpMouse` kept `buttons: Left` set — so every later
// `mouse.down()` (e.g. `tab.click`, another `tab.drag`) threw
// `"left is already pressed."` for the rest of the worker's life. The
// extracted `dispatchDragMouseSequence` helper releases the button best-effort
// in `finally` once `down()` committed. These tests drive the real helper
// against a fake `CdpMouse` that mirrors the puppeteer state machine (down
// throws "already pressed" and commits Left; up throws "not pressed" and
// clears Left; move records), asserting the externally observable contract:
// after any exit path, a subsequent `down()` would NOT see the button stuck.

const Left = 0b001;

interface DragMouseCall {
	method: "move" | "down" | "up";
	x?: number;
	y?: number;
	steps?: number;
}

interface FakeMouseState {
	buttons: number;
	calls: DragMouseCall[];
}

function makeMouse(
	hooks: {
		move?: (this: FakeMouseState, x: number, y: number, options?: { steps?: number }) => Promise<void>;
		down?: (this: FakeMouseState) => Promise<void>;
		up?: (this: FakeMouseState) => Promise<void>;
	} = {},
): DragMouse & FakeMouseState {
	const state: FakeMouseState = { buttons: 0, calls: [] };
	const mouse: DragMouse & FakeMouseState = {
		buttons: 0,
		calls: state.calls,
		async move(x, y, options) {
			state.calls.push({ method: "move", x, y, steps: options?.steps });
			await hooks.move?.call(state, x, y, options);
		},
		async down() {
			state.calls.push({ method: "down" });
			if (state.buttons & Left) throw new Error("'left' is already pressed.");
			await hooks.down?.call(state); // CDP mousePressed; commits only on success (rollback on throw)
			state.buttons |= Left;
		},
		async up() {
			state.calls.push({ method: "up" });
			if (!(state.buttons & Left)) throw new Error("'left' is not pressed.");
			await hooks.up?.call(state); // CDP mouseReleased; clears only on success
			state.buttons &= ~Left;
		},
	};
	// Keep the externally-asserted `buttons` field in sync with the closure state.
	Object.defineProperty(mouse, "buttons", {
		get: () => state.buttons,
		set: (v: number) => {
			state.buttons = v;
		},
	});
	return mouse;
}

describe("dispatchDragMouseSequence — stuck-button recovery", () => {
	it("runs move→down→move→up on the happy path and leaves the button released", async () => {
		const mouse = makeMouse();
		await dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, new AbortController().signal);

		expect(mouse.buttons).toBe(0);
		// The `up` in `try` releases the button; the redundant best-effort `up`
		// in `finally` then throws "not pressed" and is swallowed — so a
		// subsequent down() would succeed. The recorded sequence proves both
		// the press/release ordering and the redundant-then-harmless release.
		expect(mouse.calls).toEqual([
			{ method: "move", x: 1, y: 2, steps: undefined },
			{ method: "down", x: undefined, y: undefined, steps: undefined },
			{ method: "move", x: 9, y: 8, steps: 12 },
			{ method: "up", x: undefined, y: undefined, steps: undefined },
			{ method: "up", x: undefined, y: undefined, steps: undefined },
		]);
		// And the very next down() must not collide with a stuck bit.
		await mouse.down();
		await mouse.up();
	});

	it("releases the button when the drag is aborted mid-move (the stuck-button regression)", async () => {
		// Faithful to the real `untilAborted` mechanism: the signal aborts while
		// the wedged end-move is still pending, so the outer promise rejects with
		// an AbortError and `mouse.up()` in the `try` is skipped — but the
		// recovery `up()` in `finally` must still release the committed button.
		const ac = new AbortController();
		const neverSettles = Promise.withResolvers<void>();
		const mouse = makeMouse({
			move(x, y, options) {
				if (options?.steps === 12) {
					// Abort lands AFTER down() committed but while this move is in flight.
					queueMicrotask(() => ac.abort());
					return neverSettles.promise;
				}
				return Promise.resolve();
			},
		});

		await expect(dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, ac.signal)).rejects.toThrow(
			/Aborted/,
		);

		expect(mouse.buttons).toBe(0);
		expect(mouse.calls.filter(c => c.method === "up")).toHaveLength(1); // the recovery release only
		expect(mouse.calls.filter(c => c.method === "down")).toHaveLength(1);
		await mouse.down(); // a later tab.click would work — no stuck "already pressed"
		await mouse.up();
	});

	it("releases the button and rethrows when a CDP error rejects the mid-drag move", async () => {
		const mouse = makeMouse({
			move(x, y, options) {
				if (options?.steps === 12) throw new Error("Protocol error: target flushed");
				return Promise.resolve();
			},
		});

		await expect(
			dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, new AbortController().signal),
		).rejects.toThrow("Protocol error: target flushed");

		// Recovery release clears the committed button; the original CDP error
		// still propagates (the best-effort `up()` catch does not mask it).
		expect(mouse.buttons).toBe(0);
		expect(mouse.calls.filter(c => c.method === "up")).toHaveLength(1);
		await mouse.down(); // subsequent op unaffected
		await mouse.up();
	});

	it("does not call up() in finally when the pre-down move is aborted (down was never issued)", async () => {
		const ac = new AbortController();
		const neverSettles = Promise.withResolvers<void>();
		const mouse = makeMouse({
			move(x, y, options) {
				// The move-to-start (no steps) is the wedged op here; abort lands in flight.
				if (options?.steps === undefined) {
					queueMicrotask(() => ac.abort());
					return neverSettles.promise;
				}
				return Promise.resolve();
			},
		});

		await expect(dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, ac.signal)).rejects.toThrow(
			/Aborted/,
		);

		expect(mouse.buttons).toBe(0);
		expect(mouse.calls.filter(c => c.method === "down")).toHaveLength(0);
		expect(mouse.calls.filter(c => c.method === "up")).toHaveLength(0); // no recovery, nothing committed
	});

	it("does not call up() in finally when down() itself rejects (the press never commits)", async () => {
		const mouse = makeMouse({
			down() {
				throw new Error("Protocol error: mousePressed failed");
			},
		});

		await expect(
			dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, new AbortController().signal),
		).rejects.toThrow("Protocol error: mousePressed failed");

		// The fake (like CdpMouse's #withTransaction rollback) leaves the button
		// uncommitted when down() throws, so no recovery release is warranted.
		expect(mouse.buttons).toBe(0);
		expect(mouse.calls.filter(c => c.method === "up")).toHaveLength(0);
	});

	it("swallows a failing recovery up() and still rejects with the original drag error", async () => {
		// On a wedged/detaching page the recovery `up()` can itself reject; the
		// best-effort `up().catch(() => undefined)` must not mask the original
		// failure nor turn the recovery into a second thrown error.
		const ac = new AbortController();
		const neverSettles = Promise.withResolvers<void>();
		const mouse = makeMouse({
			move(x, y, options) {
				if (options?.steps === 12) {
					queueMicrotask(() => ac.abort());
					return neverSettles.promise;
				}
				return Promise.resolve();
			},
			up() {
				// Recovery release can't reach the target either.
				throw new Error("Protocol error: target closed");
			},
		});

		await expect(dispatchDragMouseSequence(mouse, { x: 1, y: 2 }, { x: 9, y: 8 }, ac.signal)).rejects.toThrow(
			/Aborted/,
		);

		// The original abort propagates (not the up() error) and exactly one
		// recovery up() was attempted — the wedge caveat (no commit on a fully
		// wedged page) is documented in the report and out of scope here.
		expect(mouse.calls.filter(c => c.method === "up")).toHaveLength(1);
	});
});
