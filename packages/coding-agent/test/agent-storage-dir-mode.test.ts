import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hardenAgentDbFilePermissions } from "../src/session/agent-storage-permissions.ts";

function modeOf(p: string): number {
	return fs.statSync(p).mode & 0o777;
}

describe("hardenAgentDbFilePermissions (#10413)", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("does not chmod an existing agent directory back to 0700", () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-dir-mode-"));
		fs.chmodSync(tempDir, 0o775);
		const dbPath = path.join(tempDir, "agent.db");
		fs.writeFileSync(dbPath, "");
		fs.chmodSync(dbPath, 0o664);

		hardenAgentDbFilePermissions(dbPath);

		expect(modeOf(tempDir)).toBe(0o775);
		expect(modeOf(dbPath)).toBe(0o600);
	});
});
