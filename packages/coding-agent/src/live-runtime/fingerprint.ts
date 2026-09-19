import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** Deterministic hex fingerprint of UTF-8 / binary bytes. */
export function fingerprintBytes(data: Uint8Array | string): string {
	const hash = Bun.hash(typeof data === "string" ? data : data);
	return hash.toString(16).padStart(16, "0");
}

/** Fingerprint a single on-disk file. Missing file → stable empty sentinel. */
export async function fingerprintFile(filePath: string): Promise<string> {
	try {
		const bytes = await Bun.file(filePath).arrayBuffer();
		return fingerprintBytes(new Uint8Array(bytes));
	} catch (err) {
		if (isEnoent(err)) return fingerprintBytes("");
		throw err;
	}
}

/**
 * Fingerprint an extension entry: hash the entry file contents.
 * Directories hash package.json + main/index entry when present.
 */
export async function fingerprintExtensionSource(extensionPath: string): Promise<string> {
	const resolved = path.resolve(extensionPath);
	let st: Awaited<ReturnType<typeof fs.stat>>;
	try {
		st = await fs.stat(resolved);
	} catch (err) {
		if (isEnoent(err)) return fingerprintBytes("");
		throw err;
	}

	if (st.isFile()) {
		return fingerprintFile(resolved);
	}

	const packageJsonPath = path.join(resolved, "package.json");
	let entry = path.join(resolved, "index.ts");
	try {
		const pkg = (await Bun.file(packageJsonPath).json()) as { main?: string; exports?: unknown };
		if (typeof pkg.main === "string" && pkg.main.length > 0) {
			entry = path.resolve(resolved, pkg.main);
		}
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	const parts: string[] = [];
	for (const candidate of [packageJsonPath, entry, path.join(resolved, "src", "extension.ts")]) {
		try {
			const bytes = await Bun.file(candidate).arrayBuffer();
			parts.push(`${candidate}\0${fingerprintBytes(new Uint8Array(bytes))}`);
		} catch (err) {
			if (isEnoent(err)) continue;
			throw err;
		}
	}
	if (parts.length === 0) {
		return fingerprintBytes(resolved);
	}
	return fingerprintBytes(parts.sort().join("\n"));
}

export interface CoreIdentity {
	git_sha?: string;
	source_root?: string;
	source_fingerprint: string;
}

let cachedCoreIdentity: CoreIdentity | undefined;
let cachedCoreIdentityRoot: string | undefined;

/**
 * Resolve core identity once per process/source_root.
 * Prefer git HEAD when available; always include a deterministic source fingerprint
 * over package.json (+ optional marker) so dirty trees still attest.
 */
export async function resolveCoreIdentity(options?: {
	source_root?: string;
	version?: string;
	forceRefresh?: boolean;
}): Promise<CoreIdentity> {
	const sourceRoot = path.resolve(options?.source_root ?? findDefaultSourceRoot());
	if (!options?.forceRefresh && cachedCoreIdentity && cachedCoreIdentityRoot === sourceRoot) {
		return cachedCoreIdentity;
	}

	let git_sha: string | undefined;
	try {
		const repo = vcs.git(sourceRoot) ?? vcs.repo(sourceRoot);
		git_sha = (await repo?.headSha?.()) ?? (await repo?.headId?.()) ?? undefined;
		if (git_sha) git_sha = git_sha.trim();
	} catch {
		git_sha = undefined;
	}

	const packageJsonPath = path.join(sourceRoot, "packages", "coding-agent", "package.json");
	const packageJsonAlt = path.join(sourceRoot, "package.json");
	const pkgFp = await fingerprintFile(
		(await fileExists(packageJsonPath)) ? packageJsonPath : packageJsonAlt,
	);
	const versionTag = options?.version ?? "";
	const source_fingerprint = fingerprintBytes(
		[`root=${sourceRoot}`, `git=${git_sha ?? ""}`, `pkg=${pkgFp}`, `ver=${versionTag}`].join("\n"),
	);

	cachedCoreIdentity = { git_sha, source_root: sourceRoot, source_fingerprint };
	cachedCoreIdentityRoot = sourceRoot;
	return cachedCoreIdentity;
}

/** Test seam: clear cached core identity. */
export function resetCoreIdentityCache(): void {
	cachedCoreIdentity = undefined;
	cachedCoreIdentityRoot = undefined;
}

function findDefaultSourceRoot(): string {
	// coding-agent package lives at <root>/packages/coding-agent
	return path.resolve(import.meta.dir, "../../..");
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
