/**
 * End-to-end exercise of the host-side Python tool wrappers'
 * (`callPythonTool`/`describePythonTools`) cancellation path against the
 * real subprocess-backed Python runner.
 *
 * Gated by `PI_PYTHON_INTEGRATION=1` so CI without a real Python interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail; the
 * `python-tool-cancellation.test.ts` FakeKernel suite covers the wrapper
 * logic without a kernel.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	callPythonTool,
	describePythonTools,
	disposeAllKernelSessions,
	executePython,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const SHOULD_RUN = Bun.env.PI_PYTHON_INTEGRATION === "1";

function makeSession(): ToolSession {
	return { getToolByName: () => undefined } as unknown as ToolSession;
}

const SLOW_TOOL = [
	"@tool",
	"async def slow() -> int:",
	'    """Sleep a long time before returning one."""',
	"    await asyncio.sleep(30)",
	"    return 1",
].join("\n");

describe.skipIf(!SHOULD_RUN)("python tool wrapper cancellation (real kernel)", () => {
	afterEach(async () => {
		await disposeAllKernelSessions();
	});

	it("callPythonTool throws the abort reason when the signal aborts mid-flight; the kernel survives (interruptOnCancel=false)", async () => {
		using tempDir = TempDir.createSync("@py-tool-call-mid-");
		const cwd = tempDir.path();
		const sessionId = "py-tool-call-mid-abort-int";

		const defined = await executePython(SLOW_TOOL, { cwd, sessionId });
		expect(defined.exitCode).toBe(0);

		const ac = new AbortController();
		const pending = callPythonTool("slow", {}, { cwd, sessionId, toolSession: makeSession(), signal: ac.signal });
		// Abort after the request frame has been written but well before the
		// daemon thread's `await asyncio.sleep(30)` returns — exercising the
		// post-request-written `BaseKernel.#submit` abort path with
		// `interruptOnCancel: false` (no SIGINT is dispatched; the runner's
		// late display/done frames are dropped).
		setTimeout(() => ac.abort(new DOMException("user cancelled", "AbortError")), 50);
		await expect(pending).rejects.toThrow("user cancelled");

		// Kernel must survive (interruptOnCancel: false). Serving a plain
		// cell on the same retained session verifies no SIGINT was sent.
		const alive = await executePython("print('alive')", { cwd, sessionId });
		expect(alive.cancelled).toBe(false);
		expect(alive.exitCode).toBe(0);
		expect(alive.output).toContain("alive");
	});

	it("callPythonTool throws the abort reason for a pre-aborted signal", async () => {
		using tempDir = TempDir.createSync("@py-tool-call-pre-");
		const cwd = tempDir.path();
		const sessionId = "py-tool-call-pre-abort-int";

		const defined = await executePython(SLOW_TOOL, { cwd, sessionId });
		expect(defined.exitCode).toBe(0);

		const ac = new AbortController();
		ac.abort(new DOMException("user cancelled", "AbortError"));

		await expect(
			callPythonTool("slow", {}, { cwd, sessionId, toolSession: makeSession(), signal: ac.signal }),
		).rejects.toThrow("user cancelled");
	});

	it("describePythonTools throws the abort reason for a pre-aborted signal", async () => {
		using tempDir = TempDir.createSync("@py-tool-desc-pre-");
		const cwd = tempDir.path();
		const sessionId = "py-tool-desc-pre-abort-int";

		const defined = await executePython(
			["@tool", "def add(n: int) -> int:", '    """Add one."""', "    return n + 1"].join("\n"),
			{ cwd, sessionId },
		);
		expect(defined.exitCode).toBe(0);

		const ac = new AbortController();
		ac.abort(new DOMException("user cancelled", "AbortError"));
		await expect(
			describePythonTools(["add"], { cwd, sessionId, toolSession: makeSession(), signal: ac.signal }),
		).rejects.toThrow("user cancelled");
	});

	it("happy path: callPythonTool returns the tool value when no abort is requested", async () => {
		using tempDir = TempDir.createSync("@py-tool-call-happy-");
		const cwd = tempDir.path();
		const sessionId = "py-tool-call-happy-int";

		const defined = await executePython(
			[
				"@tool",
				"async def dbl(n: int) -> int:",
				'    """Double an integer."""',
				"    await asyncio.sleep(0)",
				"    return n * 2",
			].join("\n"),
			{ cwd, sessionId },
		);
		expect(defined.exitCode).toBe(0);

		const result = await callPythonTool("dbl", { n: 21 }, { cwd, sessionId, toolSession: makeSession() });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBe(42);

		// Also describe the tool we just called (no abort) — verifies the
		// describe happy path roundtrips.
		const described = await describePythonTools(["dbl"], { cwd, sessionId, toolSession: makeSession() });
		expect(described.tools).toEqual([
			{
				name: "dbl",
				description: "Double an integer.",
				parameters: {
					type: "object",
					properties: { n: { type: "integer" } },
					required: ["n"],
					additionalProperties: false,
				},
				language: "python",
			},
		]);
		expect(described.missing).toEqual([]);
	});

	it("surfaces a kernel-side tool error as `{ ok: false, error }` when no abort is requested (regression)", async () => {
		using tempDir = TempDir.createSync("@py-tool-call-error-");
		const cwd = tempDir.path();
		const sessionId = "py-tool-call-error-int";

		const defined = await executePython(
			["@tool", "def boom(n: int) -> int:", "    raise ValueError('kaboom')"].join("\n"),
			{ cwd, sessionId },
		);
		expect(defined.exitCode).toBe(0);

		const result = await callPythonTool("boom", { n: 1 }, { cwd, sessionId, toolSession: makeSession() });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toBe("kaboom");
	});
});
