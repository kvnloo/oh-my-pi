import path from "node:path";
import { getConfig, getServersForFile } from "../config";

export interface OmpServerCommand {
	command: string;
	args: string[];
	cwd: string;
}

/** The command OMP would spawn for this extension. Null when OMP has no server. */
export function ompServerForExtension(cwd: string, extension: string): OmpServerCommand | null {
	const suffix = extension.startsWith(".") || extension === "" ? extension : `.${extension}`;
	const probe = path.join(cwd, `probe${suffix}`);
	const server = getServersForFile(getConfig(cwd), probe).find(([, candidate]) => !candidate.createClient)?.[1];
	const command = server?.resolvedCommand ?? server?.command;
	if (!server || !command) return null;
	return { command, args: server.args ?? [], cwd };
}
