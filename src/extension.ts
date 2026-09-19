/**
 * z0 live-runtime bootstrap/operator extension.
 * Registers /runtime status|reload|reload-all and request_runtime_reload tool.
 * No AGY / Cognitive State / Braid / RLM / Tokenomics logic here.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	broadcastReloadAll,
	getRuntimeAttestation,
	listRuntimeRegistry,
	pruneDeadRegistryEntries,
	readPendingActivationMarker,
	clearPendingActivationMarker,
	sendControlMessage,
	type RuntimeSnapshot,
} from "@oh-my-pi/pi-coding-agent/live-runtime";
import {
	formatRuntimeStatus,
	formatRuntimeStatusAll,
	summarizeExpected,
} from "./format.ts";
import { EXPECTED_EXTENSIONS } from "./manifest.ts";

const QUEUED_RELOAD_KEY = "__omp_z0_runtime_reload_queued_generation";

export default function z0LiveRuntimeExtension(pi: ExtensionAPI): void {
	pi.setLabel("z0-live-runtime");

	pi.on("session_start", async (_event, ctx) => {
		const pending = await readPendingActivationMarker();
		const attestation = getRuntimeAttestation();
		if (pending && attestation) {
			const from = pending.from_generation;
			const to = attestation.generation;
			ctx.ui.notify(`↻ runtime reload: generation ${from} → ${to}`, "info");
			await clearPendingActivationMarker();
		}
	});

	pi.registerCommand("runtime", {
		description: "Inspect or reload the live OMP runtime generation",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const verb = parts[0] ?? "status";
			const flags = new Set(parts.slice(1));

			if (verb === "status") {
				const attestation = getRuntimeAttestation();
				if (!attestation) {
					ctx.ui.notify("Runtime attestation not initialized in this session.", "error");
					return;
				}
				if (flags.has("--all")) {
					const profileId = process.env.OMP_PROFILE || "default";
					await pruneDeadRegistryEntries(profileId);
					const entries = await listRuntimeRegistry(profileId);
					const localSnap = await attestation.snapshot();
					const rows = [];
					for (const entry of entries) {
						let snap: RuntimeSnapshot | undefined;
						let busy = entry.pid === process.pid && attestation.isBusy ? "busy" : "idle";
						if (entry.session_id === localSnap.session.session_id) {
							snap = localSnap;
							busy = attestation.isBusy ? "busy" : "idle";
						} else {
							try {
								const reply = await sendControlMessage(
									entry.socket_path,
									{ type: "status_request", request_id: `status-all-${entry.session_id}` },
									2500,
								);
								if (reply.type === "status_reply") {
									busy = reply.busy;
									if (reply.snapshot && typeof reply.snapshot === "object") {
										snap = reply.snapshot as RuntimeSnapshot;
									}
								}
							} catch {
								snap = undefined;
							}
						}
						if (!snap) {
							rows.push({
								session_id: entry.session_id,
								pid: entry.pid,
								core: entry.core_sha ?? "?",
								generation: entry.runtime_generation,
								cognitive: "UNKNOWN" as const,
								agy: "UNKNOWN" as const,
								agy_sha: "-",
								state: busy,
							});
							continue;
						}
						const summary = summarizeExpected(snap);
						rows.push({
							session_id: entry.session_id,
							pid: entry.pid,
							core: entry.core_sha ?? snap.core.git_sha ?? "?",
							generation: snap.runtime.generation ?? entry.runtime_generation,
							cognitive: summary.cognitive,
							agy: summary.agy,
							agy_sha: summary.agy_sha,
							state: busy,
						});
					}
					if (rows.length === 0) {
						const summary = summarizeExpected(localSnap);
						rows.push({
							session_id: localSnap.session.session_id,
							pid: localSnap.process.pid,
							core: localSnap.core.git_sha ?? "?",
							generation: localSnap.runtime.generation,
							cognitive: summary.cognitive,
							agy: summary.agy,
							agy_sha: summary.agy_sha,
							state: attestation.isBusy ? "busy" : "idle",
						});
					}
					if (flags.has("--json")) {
						ctx.ui.notify(JSON.stringify({ schema: "omp.runtime.status_all.v1", rows }, null, 2), "info");
					} else {
						ctx.ui.notify(formatRuntimeStatusAll(rows), "info");
					}
					return;
				}

				const snapshot = await attestation.snapshot();
				if (flags.has("--json")) {
					ctx.ui.notify(JSON.stringify(snapshot, null, 2), "info");
				} else {
					ctx.ui.notify(formatRuntimeStatus(snapshot), "info");
				}
				return;
			}

			if (verb === "reload") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("RELOAD_PENDING — will apply after safe boundary", "warning");
				}
				// Terminal for this command frame (ctx.reload contract).
				await ctx.reload();
				return;
			}

			if (verb === "reload-all") {
				const profileId = process.env.OMP_PROFILE || "default";
				const result = await broadcastReloadAll({ profileId, reason: "operator-reload-all" });
				ctx.ui.notify(JSON.stringify(result, null, 2), "info");
				return;
			}

			ctx.ui.notify("Usage: /runtime status [--json] [--all] | /runtime reload | /runtime reload-all", "error");
		},
	});

	pi.registerTool({
		name: "request_runtime_reload",
		label: "Request Runtime Reload",
		description:
			"Queue /runtime reload after the current turn. Does not reload immediately. Agent-attributed.",
		parameters: pi.zod.object({
			reason: pi.zod.string().optional().describe("Why reload is needed"),
		}),
		async execute(_id, params) {
			const attestation = getRuntimeAttestation();
			const generation = attestation?.generation ?? 0;
			const queued = Reflect.get(globalThis, QUEUED_RELOAD_KEY);
			if (queued === generation) {
				return {
					content: [{ type: "text", text: `Reload already queued for generation ${generation}.` }],
					details: { queued: true, deduped: true, generation },
				};
			}
			Reflect.set(globalThis, QUEUED_RELOAD_KEY, generation);
			void params.reason;
			pi.sendUserMessage("/runtime reload", {
				deliverAs: "followUp",
				attribution: "agent",
			});
			return {
				content: [
					{
						type: "text",
						text: `Queued /runtime reload as an agent-attributed follow-up (generation ${generation}).`,
					},
				],
				details: { queued: true, deduped: false, generation },
			};
		},
	});

	void EXPECTED_EXTENSIONS;
}
