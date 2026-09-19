import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { RuntimeActivationStrategy } from "./types";

export const PENDING_ACTIVATION_FILENAME = "pending-runtime-activation.json";

export interface PendingActivationMarker {
	schema: "omp.runtime.pending.v1";
	from_generation: number;
	requested_at: string;
	reason: string;
	changed_files: string[];
	strategy: RuntimeActivationStrategy;
	session_id?: string;
}

export function pendingActivationPath(agentDir?: string): string {
	return path.join(agentDir ?? getAgentDir(), "runtime", PENDING_ACTIVATION_FILENAME);
}

export async function writePendingActivationMarker(
	marker: PendingActivationMarker,
	agentDir?: string,
): Promise<string> {
	const filePath = pendingActivationPath(agentDir);
	await Bun.write(filePath, `${JSON.stringify(marker, null, "\t")}\n`);
	return filePath;
}

export async function readPendingActivationMarker(
	agentDir?: string,
): Promise<PendingActivationMarker | undefined> {
	const filePath = pendingActivationPath(agentDir);
	try {
		return (await Bun.file(filePath).json()) as PendingActivationMarker;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function clearPendingActivationMarker(agentDir?: string): Promise<void> {
	const filePath = pendingActivationPath(agentDir);
	try {
		await fs.unlink(filePath);
	} catch (err) {
		if (isEnoent(err)) return;
		throw err;
	}
}
