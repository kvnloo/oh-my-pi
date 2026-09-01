import * as fs from "node:fs";

/**
 * Lock down the agent SQLite file. The containing directory is created with
 * mode 0o700 in `#ensureDir`; re-chmod of an existing user directory clobbers
 * shared-group modes (issue #10413).
 */
export function hardenAgentDbFilePermissions(dbPath: string): void {
	if (!fs.existsSync(dbPath)) return;
	try {
		fs.chmodSync(dbPath, 0o600);
	} catch {
		// Best-effort; AgentStorage logs the equivalent failure.
	}
}
