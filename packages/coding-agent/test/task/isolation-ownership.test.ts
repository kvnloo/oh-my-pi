import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";
import { needsNativeTeardown, writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";

const { IsoBackendKind } = natives;

// The sidecar set decides which retained workspaces `omp worktree clear`
// routes through native `isoStop` instead of plain recursive `rm`.
describe("retained workspace teardown set", () => {
	it("routes mounts and subvolumes through native teardown, nothing else", () => {
		for (const kind of [IsoBackendKind.Overlayfs, IsoBackendKind.Projfs, IsoBackendKind.Btrfs]) {
			expect(needsNativeTeardown(kind)).toBe(true);
		}
		for (const kind of [
			IsoBackendKind.Apfs,
			// ZFS clones need dataset-aware teardown too, but isoStop locates
			// the dataset by its recorded mountpoint property, which no longer
			// matches after the retain rename — pi-iso mount-table support first.
			IsoBackendKind.Zfs,
			IsoBackendKind.LinuxReflink,
			IsoBackendKind.WindowsBlockClone,
			IsoBackendKind.Rcopy,
		]) {
			expect(needsNativeTeardown(kind)).toBe(false);
		}
	});

	it("rejects non-backend values", () => {
		for (const value of [undefined, null, "overlayfs", 1.5, -1, 999]) {
			expect(needsNativeTeardown(value)).toBe(false);
		}
	});
});

describe("task artifact lease", () => {
	it("records an explicit owner and seven-day lease without renewal", async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-lease-test-"));
		try {
			await writeIsolationOwner(base, "task-1");
			const file = path.join(base, ".artifact-lease.json");
			const first = await Bun.file(file).json();
			expect(first.schema).toBe("z0.artifact-lease.v1");
			expect(first.path).toBe(base);
			expect(first.owner).toBe("omp:task-1");
			expect(first.ttl).toBe(604800);
			expect(first.keep_receipts).toContain(".omp-isolation-owner.json");
			await writeIsolationOwner(base, "task-2");
			expect(await Bun.file(file).json()).toEqual(first);
		} finally {
			await fs.rm(base, { recursive: true, force: true });
		}
	});
});
