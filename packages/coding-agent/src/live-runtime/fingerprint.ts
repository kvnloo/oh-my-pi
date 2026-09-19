import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";

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

async function readPackageManifest(packageRoot: string): Promise<Record<string, unknown> | undefined> {
	try {
		const raw = await Bun.file(path.join(packageRoot, "package.json")).json();
		return isRecord(raw) ? raw : undefined;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

function declaredExtensionEntries(manifest: Record<string, unknown> | undefined): string[] {
	if (!manifest) return [];
	const omp = isRecord(manifest.omp) ? manifest.omp : undefined;
	const pi = isRecord(manifest.pi) ? manifest.pi : undefined;
	const entries = omp?.extensions ?? pi?.extensions;
	return Array.isArray(entries) ? entries.filter((e): e is string => typeof e === "string") : [];
}

/**
 * Walk parents for a package.json that declares omp/pi extensions.
 * Stops at filesystem root; returns undefined for bare single-file extensions.
 */
export async function findExtensionPackageRoot(extensionPath: string): Promise<string | undefined> {
	let dir = path.resolve(extensionPath);
	try {
		const st = await fs.stat(dir);
		if (st.isFile()) dir = path.dirname(dir);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}

	for (let i = 0; i < 8; i++) {
		const manifest = await readPackageManifest(dir);
		if (declaredExtensionEntries(manifest).length > 0) return dir;
		// Also accept packages that ship src/extension.ts next to package.json (common z0 layout)
		if (manifest && (await fileExists(path.join(dir, "src", "extension.ts")))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

async function collectPackageFingerprintParts(packageRoot: string, entryFile?: string): Promise<string[]> {
	const parts: string[] = [];
	const packageJsonPath = path.join(packageRoot, "package.json");
	const manifest = await readPackageManifest(packageRoot);
	const declared = declaredExtensionEntries(manifest).map(e => path.resolve(packageRoot, e));
	const candidates = new Set<string>([
		packageJsonPath,
		...(entryFile ? [path.resolve(entryFile)] : []),
		...declared,
		path.join(packageRoot, "index.ts"),
		path.join(packageRoot, "src", "extension.ts"),
	]);

	for (const candidate of candidates) {
		try {
			const bytes = await Bun.file(candidate).arrayBuffer();
			parts.push(`${path.relative(packageRoot, candidate) || path.basename(candidate)}\0${fingerprintBytes(new Uint8Array(bytes))}`);
		} catch (err) {
			if (!isEnoent(err)) throw err;
		}
	}
	return parts;
}

/**
 * Fingerprint an extension entry.
 *
 * - Bare files: hash file contents.
 * - Package entries (`index.ts` re-exporting `./src/extension.ts`): hash package.json +
 *   declared entries + `src/extension.ts` so identical barrel files do not collide.
 * - Directories: same package hash set.
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

	const packageRoot = st.isDirectory() ? resolved : await findExtensionPackageRoot(resolved);
	if (packageRoot) {
		const parts = await collectPackageFingerprintParts(packageRoot, st.isFile() ? resolved : undefined);
		if (parts.length > 0) return fingerprintBytes(parts.sort().join("\n"));
		return fingerprintBytes(packageRoot);
	}

	if (st.isFile()) return fingerprintFile(resolved);
	return fingerprintBytes(resolved);
}

/** Resolve git HEAD for an extension path's package/repo when available. */
export async function resolveExtensionGitSha(extensionPath: string): Promise<string | undefined> {
	const packageRoot = (await findExtensionPackageRoot(extensionPath)) ?? path.resolve(extensionPath);
	const root = (await fs.stat(packageRoot).then(s => (s.isDirectory() ? packageRoot : path.dirname(packageRoot))).catch(() => path.dirname(path.resolve(extensionPath))));
	try {
		const repo = vcs.git(root) ?? vcs.repo(root);
		const sha = (await repo?.headSha?.()) ?? (await repo?.headId?.()) ?? undefined;
		return sha?.trim() || undefined;
	} catch {
		return undefined;
	}
}

export interface CoreIdentity {
	git_sha?: string;
	source_root: string;
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
