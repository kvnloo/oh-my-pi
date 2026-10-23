import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";
import type { CostEstimatorContext } from "@oh-my-pi/pi-agent-core";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import {
	type AgentTelemetryConfig,
	type ChatUsageEvent,
	GenAIAttr,
	OmpGenAIAttr,
	recordManualChatTelemetry,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { AgentContext, AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createTelemetryExportConfig,
	initTelemetryExport,
	isTelemetryExportEnabled,
} from "@oh-my-pi/pi-coding-agent/telemetry-export";
import { estimateProviderCost } from "@oh-my-pi/pi-coding-agent/telemetry-export-otlp";
import { cfgTelemetryOtlpExportEnabled } from "@oh-my-pi/pi-coding-agent/telemetry-settings";

/**
 * Gating contract for the OTLP export bootstrap. These cases all short-circuit
 * before a provider is registered, so they never mutate the module singleton
 * and are order-independent. Transport-path probes run in subprocesses so any
 * registered global provider can't leak into the test runner.
 */
const OTEL_KEYS = [
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
	"OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
	"OTEL_SDK_DISABLED",
	"OTEL_TRACES_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_METRICS_EXPORTER",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(OTEL_KEYS.map(k => [k, process.env[k]]));
	for (const k of OTEL_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of OTEL_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

describe("initTelemetryExport gating", () => {
	it("stays disabled when no OTLP endpoint is configured", async () => {
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("keeps OTLP export disabled when the user opts out despite configured endpoints", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318/v1/traces";
		const settings = Settings.isolated({ "telemetry.otlpExportEnabled": false });
		await initTelemetryExport(cfgTelemetryOtlpExportEnabled.get(settings));
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_SDK_DISABLED=true even with an endpoint", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "true";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when OTEL_TRACES_EXPORTER=none and only the traces endpoint is set", async () => {
		process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("declines unsupported OTLP protocols instead of misrouting spans", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4317";
		process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);

		process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("honors the kill-switches case-insensitively per the OTEL env contract", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_SDK_DISABLED = "TRUE";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);

		delete process.env.OTEL_SDK_DISABLED;
		process.env.OTEL_TRACES_EXPORTER = "otlp,None";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});

	it("stays disabled when every signal exporter is set to none", async () => {
		process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
		process.env.OTEL_TRACES_EXPORTER = "none";
		process.env.OTEL_LOGS_EXPORTER = "none";
		process.env.OTEL_METRICS_EXPORTER = "none";
		await initTelemetryExport(true);
		expect(isTelemetryExportEnabled()).toBe(false);
	});
});

describe("initTelemetryExport exporter selection", () => {
	it("does not send OTLP when console is explicitly selected for every signal", async () => {
		const probe = fileURLToPath(new URL("./otel-non-otlp-probe.ts", import.meta.url));
		const proc = Bun.spawn([process.execPath, probe], {
			env: { ...process.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		expect({ exitCode, output: (await output).trim() }).toEqual({
			exitCode: 0,
			output: "PROBE: NO_EXPORT",
		});
	}, 10_000);
});

describe("initTelemetryExport signals export path", () => {
	it("exports every OTLP/proto signal and merged resource attributes", async () => {
		// Positive initialization registers process-global providers, so each
		// scenario still runs in its own process. Starting the independent probes
		// together avoids serially paying three Bun startup and exporter-flush waits.
		const probes = [
			["traces", "./otel-export-probe.ts"],
			["logs and metrics", "./otel-signals-probe.ts"],
			["resource attributes", "./otel-resource-probe.ts"],
		] as const;
		const results = await Promise.all(
			probes.map(async ([name, relativePath]) => {
				const probe = fileURLToPath(new URL(relativePath, import.meta.url));
				const proc = Bun.spawn([process.execPath, probe], {
					// Bun otherwise inherits the process's original native environment,
					// including external OTEL kill-switches removed in beforeEach.
					env: { ...process.env },
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				});
				return [name, await proc.exited] as const;
			}),
		);

		expect(Object.fromEntries(results)).toEqual({
			traces: 0,
			"logs and metrics": 0,
			"resource attributes": 0,
		});
	}, 20_000);
});


/**
 * Synthetic native spans, captured by an in-memory SDK processor. An explicit
 * tracer is injected through the existing agent telemetry config; no global
 * provider registration, OTLP endpoint, network export, or live model call.
 * These are fork-lab contract fixtures, not proof of an installed exporter.
 */
describe("telemetry export evidence contracts (in memory)", () => {
	it("keeps a shared trace and distinct attempt IDs without exporting prompt, tool, or secret bodies", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		const secret = "SYNTHETIC_SECRET_DO_NOT_EXPORT_4df2";
		const rawPrompt = "SYNTHETIC_RAW_PROMPT_DO_NOT_EXPORT_9ec5";
		const toolSchema = type({ query: type("string"), token: type("string") });
		const tool: AgentTool<typeof toolSchema> = {
			name: "lookup",
			label: "Lookup",
			description: "Synthetic lookup",
			parameters: toolSchema,
			execute: async () => ({
				content: [{ type: "text", text: rawPrompt }],
				details: { token: secret },
			}),
		};
		const mock = createMockModel({
			provider: "mock-provider",
			id: "export-synthetic",
			responses: [
				{ content: [{ type: "toolCall", id: "call-1", name: "lookup", arguments: { query: rawPrompt, token: secret } }] },
				{ content: [rawPrompt + " " + secret] },
			],
		});
		const config: AgentTelemetryConfig = {
			tracer: provider.getTracer("synthetic-export-contract"),
			captureMessageContent: false,
			conversationId: "synthetic-conversation",
			resolveAttributes: ctx => ({
				"z0.execution_ref": "synthetic-receipt-1",
				...(ctx.kind === "chat" ? { "z0.attempt_id": "attempt-" + ctx.stepNumber } : {}),
			}),
		};

		try {
			// With no registered OTLP signals this API must preserve the native
			// telemetry callbacks and attribute policy without exporting remotely.
			expect(createTelemetryExportConfig(config)).toBe(config);
			expect(isTelemetryExportEnabled()).toBe(false);
			const context: AgentContext = { systemPrompt: [secret], messages: [], tools: [tool] };
			const identityConverter = (messages: AgentMessage[]): Message[] =>
				messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
			for await (const _event of agentLoop(
				[{ role: "user", content: rawPrompt + " " + secret, timestamp: 1 }],
				context,
				{ model: mock.model, convertToLlm: identityConverter, telemetry: config },
				undefined,
				mock.stream,
			)) {
				// Drain the real agent loop so both synthetic provider attempts finish.
			}
			await provider.forceFlush();

			const spans = exporter.getFinishedSpans();
			const invoke = spans.find(s => s.name === "invoke_agent");
			const chats = spans.filter(s => s.name === "chat export-synthetic");
			const executeTool = spans.find(s => s.name === "execute_tool lookup");
			expect(invoke).toBeDefined();
			expect(chats).toHaveLength(2);
			expect(executeTool).toBeDefined();
			expect(chats.map(s => s.attributes["z0.attempt_id"]).sort()).toEqual(["attempt-0", "attempt-1"]);
			expect(chats.map(s => s.attributes[OmpGenAIAttr.AgentStepNumber]).sort()).toEqual([0, 1]);
			for (const chat of chats) {
				expect(chat.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);
				expect(chat.spanContext().traceId).toBe(invoke?.spanContext().traceId);
				expect(chat.attributes[GenAIAttr.ConversationId]).toBe("synthetic-conversation");
			}
			expect(new Set(chats.map(s => s.spanContext().spanId)).size).toBe(2);
			expect(executeTool?.parentSpanContext?.spanId).toBe(invoke?.spanContext().spanId);
			expect(executeTool?.attributes[GenAIAttr.ToolCallId]).toBe("call-1");
			expect(spans.every(s => s.attributes["z0.execution_ref"] === "synthetic-receipt-1")).toBe(true);

			// Assert the observed span payload, not the fixture's input. Both the
			// request and mock response include content that must remain local.
			const evidence = JSON.stringify(spans.map(s => ({ attributes: s.attributes, events: s.events })));
			expect(evidence).not.toContain(secret);
			expect(evidence).not.toContain(rawPrompt);
		} finally {
			await provider.shutdown();
		}
	});

	it("does not turn an absent usage report into a recorded zero or an estimated cost", async () => {
		const exporter = new InMemorySpanExporter();
		const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
		const observedUsage: ChatUsageEvent[] = [];
		let estimateCalls = 0;
		const config: AgentTelemetryConfig = {
			tracer: provider.getTracer("synthetic-missing-usage"),
			captureMessageContent: false,
			onChatUsage: event => {
				observedUsage.push(event);
			},
			costEstimator: context => {
				estimateCalls++;
				return estimateProviderCost(context, () => false);
			},
		};
		try {
			expect(createTelemetryExportConfig(config)).toBe(config);
			const telemetry = resolveTelemetry(config, "synthetic-conversation");
			const mock = createMockModel({ provider: "mock-provider", id: "missing-usage", responses: [] });
			// Missing data and a genuinely reported zero are distinct observations.
			await recordManualChatTelemetry(telemetry, {
				model: mock.model,
				stepNumber: 0,
				finishReason: "stop",
			});
			await recordManualChatTelemetry(telemetry, {
				model: mock.model,
				stepNumber: 1,
				finishReason: "stop",
				usage: {
					input: 0,
					output: 0,
					totalTokens: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			await provider.forceFlush();

			const chats = exporter.getFinishedSpans().filter(s => s.name === "chat missing-usage");
			expect(chats).toHaveLength(2);
			const missing = chats.find(s => s.attributes[OmpGenAIAttr.AgentStepNumber] === 0);
			const reportedZero = chats.find(s => s.attributes[OmpGenAIAttr.AgentStepNumber] === 1);
			expect(missing).toBeDefined();
			expect(reportedZero).toBeDefined();
			expect(missing?.attributes[GenAIAttr.UsageInputTokens]).toBeUndefined();
			expect(missing?.attributes[GenAIAttr.UsageOutputTokens]).toBeUndefined();
			expect(missing?.attributes[OmpGenAIAttr.UsageTotalTokens]).toBeUndefined();
			expect(missing?.attributes[OmpGenAIAttr.CostEstimatedUsd]).toBeUndefined();
			expect(missing?.attributes[OmpGenAIAttr.CostUnavailableReason]).toBeUndefined();
			expect(reportedZero?.attributes[GenAIAttr.UsageInputTokens]).toBe(0);
			expect(reportedZero?.attributes[GenAIAttr.UsageOutputTokens]).toBe(0);
			expect(reportedZero?.attributes[OmpGenAIAttr.UsageTotalTokens]).toBe(0);
			expect(reportedZero?.attributes[OmpGenAIAttr.CostUnavailableReason]).toBe("model_price_unavailable");
			expect(reportedZero?.attributes[OmpGenAIAttr.CostEstimatedUsd]).toBeUndefined();
			expect(estimateCalls).toBe(1);
			expect(observedUsage).toHaveLength(1);
			expect(observedUsage[0]?.stepNumber).toBe(1);
			expect(observedUsage[0]?.usage.totalTokens).toBe(0);
		} finally {
			await provider.shutdown();
		}
	});
});

describe("estimateProviderCost", () => {
	// A Codex subscription request: OTel labels the provider `openai`, and the
	// response may name a served model rather than the requested one.
	const context: CostEstimatorContext = {
		provider: "openai",
		providerId: "openai-codex",
		model: "served-model",
		modelId: "requested-model",
		serviceTier: undefined,
		usage: {
			inputTokens: 1_500,
			outputTokens: 500,
			totalTokens: 2_000,
			cachedInputTokens: 400,
			cacheWriteTokens: 100,
			reasoningOutputTokens: 0,
		},
		usageCost: { input: 0.2, output: 0.8, cacheRead: 0.04, cacheWrite: 0.06, total: 1.1 },
	};

	it("reports the request's computed cost when the requested model has known pricing", () => {
		const result = estimateProviderCost(
			context,
			(providerId, modelId) => providerId === "openai-codex" && modelId === "requested-model",
		);

		expect(result).toEqual({ usd: 1.1, inputUsd: 0.2, outputUsd: 0.8 });
	});
	it("preserves a provider-reported charge while distinguishing unpriced zero from a free priced request", () => {
		const providerReported: CostEstimatorContext = {
			...context,
			usageCost: { input: 0.42, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.42 },
		};
		expect(estimateProviderCost(providerReported, () => false)).toEqual({
			usd: 0.42,
			inputUsd: 0.42,
			outputUsd: 0,
		});

		const unpricedZero: CostEstimatorContext = {
			...context,
			usageCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(estimateProviderCost(unpricedZero, () => false)).toEqual({ unavailable: "model_price_unavailable" });
		expect(estimateProviderCost(unpricedZero, () => true)).toEqual({
			usd: 0,
			inputUsd: 0,
			outputUsd: 0,
		});
	});
});
