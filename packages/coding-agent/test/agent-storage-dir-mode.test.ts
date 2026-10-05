import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const posixIt = process.platform === "win32" ? it.skip : it;

function modeOf(target: string): number {
	return fs.statSync(target).mode & 0o777;
}

describe("AgentStorage permissions", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		AgentStorage.close();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	posixIt("preserves an existing agent directory mode while hardening agent.db", async () => {
		tempDir = TempDir.createSync("@omp-agent-dir-mode-");
		fs.chmodSync(tempDir.path(), 0o775);
		const dbPath = path.join(tempDir.path(), "agent.db");

		await AgentStorage.open(dbPath);

		expect(modeOf(tempDir.path())).toBe(0o775);
		expect(modeOf(dbPath)).toBe(0o600);
	});
});
