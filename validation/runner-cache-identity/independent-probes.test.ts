import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stageRunnerScript } from "../../packages/coding-agent/src/eval/runner-cache";
import { ownerPrivateDirError } from "../../packages/coding-agent/src/utils/owner-private-dir";

const prefix = `omp-runner-critic-${process.pid}-${Date.now()}-`;
let sequence = 0;
const nextName = () => `${prefix}${sequence++}`;
const stagingDir = (name: string) => path.join(os.tmpdir(), process.getuid ? `${name}-${process.getuid()}` : name);
const run = (file: string) => {
	const result = Bun.spawnSync([process.execPath, file]);
	expect(result.exitCode).toBe(0);
	return result.stdout.toString().trim();
};

afterAll(() => {
	for (const entry of fs.readdirSync(os.tmpdir())) {
		if (entry.startsWith(prefix)) fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true });
	}
});

describe("independent runner-cache identity controls", () => {
	it("returns the requested executable for A to B to A source changes", async () => {
		const name = nextName();
		const a = await stageRunnerScript(name, "js", "console.log('A');\n");
		const b = await stageRunnerScript(name, "js", "console.log('B');\n");
		const again = await stageRunnerScript(name, "js", "console.log('A');\n");
		expect(a).not.toBe(b);
		expect(again).toBe(a);
		expect([run(a), run(b), run(again)]).toEqual(["A", "B", "A"]);
	});

	it("keeps extension identity through A to B to A alternation", async () => {
		const name = nextName();
		const script = "console.log('valid');\n";
		const js = await stageRunnerScript(name, "js", script);
		const ts = await stageRunnerScript(name, "ts", script);
		const again = await stageRunnerScript(name, "js", script);
		expect([path.extname(js), path.extname(ts), path.extname(again)]).toEqual([".js", ".ts", ".js"]);
		expect(again).toBe(js);
		expect([run(js), run(ts), run(again)]).toEqual(["valid", "valid", "valid"]);
	});

	it("reuses equal content without rewriting the staged file", async () => {
		const name = nextName();
		const script = "console.log('same');\n";
		const first = await stageRunnerScript(name, "js", script);
		fs.utimesSync(first, 100, 100);
		const before = fs.statSync(first);
		const second = await stageRunnerScript(name, "js", ["console.log(", "'same');\n"].join(""));
		const after = fs.statSync(second);
		expect(second).toBe(first);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(after.ino).toBe(before.ino);
		expect(run(second)).toBe("same");
	});

	it("isolates directory keys even with equal runner basenames", async () => {
		const script = "console.log('isolated');\n";
		const first = await stageRunnerScript(nextName(), "js", script);
		const second = await stageRunnerScript(nextName(), "js", script);
		expect(path.basename(first)).toBe(path.basename(second));
		expect(path.dirname(first)).not.toBe(path.dirname(second));
		fs.unlinkSync(first);
		expect(run(second)).toBe("isolated");
	});

	it("restages file-only deletion after switching source identity", async () => {
		const name = nextName();
		const first = await stageRunnerScript(name, "js", "console.log('old');\n");
		const next = await stageRunnerScript(name, "js", "console.log('new');\n");
		fs.unlinkSync(next);
		const restaged = await stageRunnerScript(name, "js", "console.log('new');\n");
		expect(restaged).toBe(next);
		expect([run(first), run(restaged)]).toEqual(["old", "new"]);
	});

	it("returns each requested identity when staging calls overlap", async () => {
		const name = nextName();
		const sources = ["console.log('one');\n", "console.log('two');\n", "console.log('three');\n"];
		const paths = await Promise.all(sources.map(script => stageRunnerScript(name, "js", script)));
		expect(paths.map(run)).toEqual(["one", "two", "three"]);
		for (let index = 0; index < sources.length; index++) {
			expect(await stageRunnerScript(name, "js", sources[index])).toBe(paths[index]);
		}
	});

	it.skipIf(!process.getuid)(
		"revalidates and repairs directory permissions on both warm and changed identity paths",
		async () => {
			const name = nextName();
			const first = await stageRunnerScript(name, "js", "console.log('safe');\n");
			const dir = path.dirname(first);
			fs.chmodSync(dir, 0o755);
			const warm = await stageRunnerScript(name, "js", "console.log('safe');\n");
			expect(warm).toBe(first);
			expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
			fs.chmodSync(dir, 0o755);
			const changed = await stageRunnerScript(name, "js", "console.log('changed');\n");
			expect(fs.statSync(path.dirname(changed)).mode & 0o777).toBe(0o700);
			expect(run(changed)).toBe("changed");
		},
	);

	it.skipIf(!process.getuid)(
		"rejects a planted changed runner after the predictable directory is replaced by a symlink",
		async () => {
			const name = nextName();
			await stageRunnerScript(name, "js", "console.log('old');\n");
			fs.rmSync(stagingDir(name), { recursive: true, force: true });
			const decoy = path.join(os.tmpdir(), `${name}-decoy`);
			fs.mkdirSync(decoy, { mode: 0o700 });
			const script = "console.log('requested');\n";
			const planted = path.join(decoy, `runner-${Bun.hash(script).toString(36)}.js`);
			await Bun.write(planted, "console.log('planted');\n");
			fs.symlinkSync(decoy, stagingDir(name));
			const changed = await stageRunnerScript(name, "js", script);
			expect(fs.realpathSync(changed)).not.toBe(fs.realpathSync(planted));
			expect(run(changed)).toBe("requested");
			expect(fs.statSync(path.dirname(changed)).mode & 0o777).toBe(0o700);
			expect(await stageRunnerScript(name, "js", script)).toBe(changed);
			const different = await stageRunnerScript(name, "js", "console.log('different');\n");
			expect(run(different)).toBe("different");
			expect(fs.statSync(path.dirname(different)).mode & 0o777).toBe(0o700);
		},
	);

	it("retains the owner/private guard rejection matrix", () => {
		const valid = { isSymlink: false, isDir: true, uid: 123, mode: 0o700 };
		expect(ownerPrivateDirError(valid, 123)).toBeNull();
		expect(ownerPrivateDirError({ ...valid, isSymlink: true }, 123)).toBe("is a symlink");
		expect(ownerPrivateDirError({ ...valid, isDir: false }, 123)).toBe("is not a directory");
		expect(ownerPrivateDirError({ ...valid, uid: 124 }, 123)).toContain("not 123");
		expect(ownerPrivateDirError({ ...valid, mode: 0o755 }, 123)).toContain("0700");
	});
});
