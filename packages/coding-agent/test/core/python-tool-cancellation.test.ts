import { afterEach, describe, expect, it } from "bun:test";
import {
	callPythonTool,
	describePythonTools,
	disposeAllKernelSessions,
	executePython,
	type PythonToolRequest,
} from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import {
	type KernelExecuteOptions,
	type KernelExecuteResult,
	type KernelShutdownResult,
	PythonKernel,
} from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

Bun.env.PI_PYTHON_SKIP_CHECK = "1";

const okResult: KernelExecuteResult = {
	status: "ok",
	cancelled: false,
	timedOut: false,
	stdinRequested: false,
};

const cancelledResult: KernelExecuteResult = {
	status: "ok",
	cancelled: true,
	timedOut: false,
	stdinRequested: false,
};

function makeSession(): ToolSession {
	return { getToolByName: () => undefined } as unknown as ToolSession;
}

interface CapturedToolInvocation {
	request: PythonToolRequest;
	options: KernelExecuteOptions | undefined;
}

/**
 * Minimal fake `PythonKernel` for exercising the host-side Python tool
 * wrappers in isolation from the real subprocess. Registers through
 * `PythonKernel.start` so the session registry surfaces it via
 * `peekLiveKernel`, then the wrappers call `invokeTool` and we assert how
 * the wrapper reacts to the returned `KernelExecuteResult` and the
 * caller-provided abort signal.
 */
class FakeToolKernel {
	readonly executeCalls: string[] = [];
	readonly toolInvocations: CapturedToolInvocation[] = [];
	#alive = true;
	#toolResult: KernelExecuteResult;
	#emitEnvelope: ((options: KernelExecuteOptions | undefined) => void) | undefined;

	constructor(toolResult: KernelExecuteResult, emitEnvelope?: (options: KernelExecuteOptions | undefined) => void) {
		this.#toolResult = toolResult;
		this.#emitEnvelope = emitEnvelope;
	}

	isAlive(): boolean {
		return this.#alive;
	}

	async execute(code: string): Promise<KernelExecuteResult> {
		this.executeCalls.push(code);
		return okResult;
	}

	async invokeTool(request: PythonToolRequest, options?: KernelExecuteOptions): Promise<KernelExecuteResult> {
		this.toolInvocations.push({ request, options });
		this.#emitEnvelope?.(options);
		return this.#toolResult;
	}

	async shutdown(): Promise<KernelShutdownResult> {
		this.#alive = false;
		return { confirmed: true };
	}

	async ping(): Promise<boolean> {
		return this.#alive;
	}
}

const originalStart = PythonKernel.start;

async function installKernel(kernel: FakeToolKernel, sessionId: string): Promise<void> {
	PythonKernel.start = (async () => kernel as unknown as PythonKernel) as typeof PythonKernel.start;
	// Run a setup cell through `executePython` so the session registry stores
	// the fake kernel under (sessionId, cwd, interpreter). The fake `.execute`
	// returns `okResult` without running the user code — we never need python.
	const setup = await executePython("pass", { sessionId, cwd: process.cwd() });
	expect(setup.exitCode).toBe(0);
	expect(setup.cancelled).toBe(false);
}

const wrapperOptions = (sessionId: string) => ({
	cwd: process.cwd(),
	sessionId,
	toolSession: makeSession(),
});

describe("Python tool wrapper cancellation (FakeKernel)", () => {
	afterEach(async () => {
		PythonKernel.start = originalStart;
		await disposeAllKernelSessions();
	});

	describe("callPythonTool", () => {
		it("throws the abort reason when invokeTool resolves with cancelled=true (pre-aborted signal)", async () => {
			const kernel = new FakeToolKernel(cancelledResult);
			await installKernel(kernel, "py-tool-call-pre-abort");
			const ac = new AbortController();
			ac.abort(new DOMException("user cancelled", "AbortError"));

			await expect(
				callPythonTool("any", {}, { ...wrapperOptions("py-tool-call-pre-abort"), signal: ac.signal }),
			).rejects.toThrow("user cancelled");
			// The wrapper still issued the invoke request before the abort
			// resolution propagated, mirroring the mid-flight abort envelope.
			expect(kernel.toolInvocations).toHaveLength(1);
			expect(kernel.toolInvocations[0]!.request).toEqual({ op: "call", name: "any", args: {} });
		});

		it("throws the abort reason even when the kernel settled before the abort landed (post-settle, valid envelope)", async () => {
			// Kernel returns a successful, fully-settled execution with a valid
			// envelope, but the caller's signal is already aborted by the time
			// the wrapper resumes — the sibling `result.cancelled ||
			// abortShield.abortRequested` gate surfaces this as cancellation
			// rather than discarding the abort behind a valid value.
			const kernel = new FakeToolKernel(okResult, options => {
				options?.onDisplay?.({ type: "json", data: { ok: true, value: "late but done" } });
			});
			await installKernel(kernel, "py-tool-call-post-settle");
			const ac = new AbortController();
			ac.abort(new DOMException("user cancelled", "AbortError"));

			await expect(
				callPythonTool("any", {}, { ...wrapperOptions("py-tool-call-post-settle"), signal: ac.signal }),
			).rejects.toThrow("user cancelled");
		});

		it("throws PythonExecutionCancelledError('Command timed out') when the kernel reports cancelled and the signal reason is a TimeoutError", async () => {
			const kernel = new FakeToolKernel(cancelledResult);
			await installKernel(kernel, "py-tool-call-timeout");
			const ac = new AbortController();
			ac.abort(new DOMException("signal timed out", "TimeoutError"));

			await expect(
				callPythonTool("any", {}, { ...wrapperOptions("py-tool-call-timeout"), signal: ac.signal }),
			).rejects.toThrow("Command timed out");
		});

		it("returns the tool value on the happy path (no signal, valid envelope)", async () => {
			const kernel = new FakeToolKernel(okResult, options => {
				options?.onDisplay?.({ type: "json", data: { ok: true, value: 42 } });
			});
			await installKernel(kernel, "py-tool-call-happy");

			const result = await callPythonTool("add", { n: 21 }, wrapperOptions("py-tool-call-happy"));
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value).toBe(42);
		});

		it("returns the kernel error value when invokeTool reports status='error' (no abort)", async () => {
			const errorResult: KernelExecuteResult = {
				status: "error",
				cancelled: false,
				timedOut: false,
				stdinRequested: false,
				error: { name: "ValueError", value: "kaboom", traceback: [] },
			};
			const kernel = new FakeToolKernel(errorResult);
			await installKernel(kernel, "py-tool-call-error");

			const result = await callPythonTool("boom", {}, wrapperOptions("py-tool-call-error"));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("kaboom");
		});

		it("returns the synthetic 'invalid response' only when settled, not aborted, and envelope is missing", async () => {
			// `cancelled=false`, `signal` not aborted, but no display envelope
			// was emitted — the pre-fix "invalid response" branch must still
			// fire so genuine protocol regressions are observable.
			const kernel = new FakeToolKernel(okResult);
			await installKernel(kernel, "py-tool-call-invalid");

			const result = await callPythonTool("any", {}, wrapperOptions("py-tool-call-invalid"));
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toBe("Python tool call returned an invalid response");
		});
	});

	describe("describePythonTools", () => {
		it("throws the abort reason when invokeTool resolves with cancelled=true (pre-aborted signal)", async () => {
			const kernel = new FakeToolKernel(cancelledResult);
			await installKernel(kernel, "py-tool-desc-pre-abort");
			const ac = new AbortController();
			ac.abort(new DOMException("user cancelled", "AbortError"));

			await expect(
				describePythonTools(["add"], { ...wrapperOptions("py-tool-desc-pre-abort"), signal: ac.signal }),
			).rejects.toThrow("user cancelled");
			expect(kernel.toolInvocations).toHaveLength(1);
			expect(kernel.toolInvocations[0]!.request).toEqual({ op: "describe", names: ["add"] });
		});

		it("returns the descriptors on the happy path (no signal, valid envelope)", async () => {
			const kernel = new FakeToolKernel(okResult, options => {
				options?.onDisplay?.({
					type: "json",
					data: {
						ok: true,
						tools: [{ name: "add", description: "Add one.", parameters: { type: "object" } }],
						missing: ["missing"],
					},
				});
			});
			await installKernel(kernel, "py-tool-desc-happy");

			const result = await describePythonTools(["add", "missing"], wrapperOptions("py-tool-desc-happy"));
			expect(result.tools).toEqual([
				{ name: "add", description: "Add one.", parameters: { type: "object" }, language: "python" },
			]);
			expect(result.missing).toEqual(["missing"]);
		});

		it("throws the kernel error value when invokeTool reports status='error' (no abort)", async () => {
			const errorResult: KernelExecuteResult = {
				status: "error",
				cancelled: false,
				timedOut: false,
				stdinRequested: false,
				error: { name: "RuntimeError", value: "describe boom", traceback: [] },
			};
			const kernel = new FakeToolKernel(errorResult);
			await installKernel(kernel, "py-tool-desc-error");

			await expect(describePythonTools(["add"], wrapperOptions("py-tool-desc-error"))).rejects.toThrow(
				"describe boom",
			);
		});

		it("throws 'invalid response' only when settled, not aborted, and envelope is missing", async () => {
			const kernel = new FakeToolKernel(okResult);
			await installKernel(kernel, "py-tool-desc-invalid");

			await expect(describePythonTools(["add"], wrapperOptions("py-tool-desc-invalid"))).rejects.toThrow(
				"Python tool describe request returned an invalid response",
			);
		});
	});
});
