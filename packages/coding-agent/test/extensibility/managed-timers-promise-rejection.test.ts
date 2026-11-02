import { describe, expect, test } from "bun:test";
import { ManagedTimers } from "../../src/extensibility/extensions/managed-timers";

describe("extension managed timer async error containment", () => {
	test("a rejected async timeout is reported while a sibling callback still runs", async () => {
		const reported = Promise.withResolvers<{ event: string; error: string }>();
		const sibling = Promise.withResolvers<void>();
		const timers = new ManagedTimers((event, error) => reported.resolve({ event, error }));

		try {
			timers.setTimeout(async () => {
				throw new Error("async callback rejected");
			}, 0);
			timers.setTimeout(() => sibling.resolve(undefined), 0);

			const [error] = await Promise.all([reported.promise, sibling.promise]);
			expect(error).toEqual({ event: "timeout_callback", error: "async callback rejected" });
		} finally {
			timers.clearAll();
		}
	});
});
