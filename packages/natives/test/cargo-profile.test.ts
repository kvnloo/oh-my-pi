import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils/which";
import { $ } from "bun";
import { napiCargoProfileArgs } from "../scripts/cargo-profile";

const require = createRequire(import.meta.url);
const manifestPath = require.resolve("@napi-rs/cli/package.json");
const manifest = require(manifestPath) as { bin: { napi: string } };
const napiBin = path.resolve(path.dirname(manifestPath), manifest.bin.napi);

// Exercise the installed artifact consumer, not just the argument array. The
// fixture requires a host Rust toolchain, has no dependencies or native actions,
// and builds completely offline. Its target directory is isolated from the repo.
test.skipIf(!$which("cargo"))(
	"copies the compiled artifact for dev, default local, ci and custom profiles",
	async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cargo-profile-"));
		try {
			await Bun.write(
				path.join(dir, "Cargo.toml"),
				'[package]\nname = "profile-fixture"\nversion = "0.1.0"\nedition = "2021"\n' +
					'[lib]\ncrate-type = ["cdylib"]\n' +
					'[profile.local]\ninherits = "dev"\n[profile.ci]\ninherits = "dev"\n' +
					'[profile.custom]\ninherits = "dev"\n',
			);
			await Bun.write(path.join(dir, "src/lib.rs"), '#[no_mangle]\npub extern "C" fn value() -> u32 { 42 }\n');
			await Bun.write(
				path.join(dir, "package.json"),
				JSON.stringify({ name: "profile-fixture", version: "0.1.0", napi: { binaryName: "profile_fixture" } }),
			);
			for (const [profile, artifactDir] of [
				[" dev ", "debug"],
				[undefined, "local"],
				["ci", "ci"],
				["custom", "custom"],
			]) {
				const output = path.join(dir, `out-${artifactDir}`);
				const args = [
					"build",
					"--manifest-path",
					path.join(dir, "Cargo.toml"),
					"--package-json-path",
					path.join(dir, "package.json"),
					"--platform",
					"--no-js",
					"-o",
					output,
					...napiCargoProfileArgs(profile),
				];
				const result = await $`${process.execPath} ${napiBin} ${args}`
					.cwd(dir)
					.env({
						...process.env,
						CARGO_BUILD_TARGET: undefined,
						CARGO_TARGET_DIR: path.join(dir, "target"),
						CARGO_NET_OFFLINE: "true",
					})
					.quiet()
					.nothrow();
				expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0);
				const addons = (await fs.readdir(output)).filter(name => name.endsWith(".node"));
				expect(addons).toHaveLength(1);
				const libraries = await Array.fromAsync(
					new Bun.Glob(`*/${artifactDir}/*profile_fixture.*`).scan(path.join(dir, "target")),
				);
				const library = libraries.find(name => /\.(so|dylib|dll)$/.test(name));
				expect(library).toBeDefined();
				expect(await Bun.file(path.join(output, addons[0])).arrayBuffer()).toEqual(
					await Bun.file(path.join(dir, "target", library!)).arrayBuffer(),
				);
			}
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	},
	30_000,
);
