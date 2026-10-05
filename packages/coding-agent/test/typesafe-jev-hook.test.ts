import { expect, it } from "bun:test";
import * as fs from "node:fs";
import path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

it("delivers the Jev skill hint without replacing existing prompt parts", async () => {
	const temp = TempDir.createSync("omp-jev-hook-");
	for (const name of ["alpha", "beta"]) {
		const dir = path.join(temp.path(), ".omp", "skills", name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Local ${name} procedure\n---\nOrdinary fixture instructions.\n`,
		);
	}
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "fixtures/typesafe-jev-hook-probe.ts"),
			path.join(import.meta.dir, "../examples/extensions/typesafe-jev.ts"),
		],
		{
			cwd: temp.path(),
			env: {
				HOME: temp.path(),
				PATH: process.env.PATH,
				TYPESAFE_API_KEY: "fixture-key",
				TYPESAFE_BASE_URL: "https://fixture.invalid",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
		const observed = JSON.parse(stdout);
		expect(observed.requests).toBe(1);
		expect(observed.original).toEqual(["Existing policy", "Existing context"]);
		expect(observed.result?.systemPrompt?.slice(0, 2)).toEqual(observed.original);
		expect(observed.result?.systemPrompt).toHaveLength(3);
		expect(observed.result.systemPrompt[2]).toContain("alpha");
	} finally {
		child.kill();
		temp.removeSync();
	}
}, 20_000);
