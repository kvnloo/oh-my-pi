import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { ReadTool } from "../../src/tools/read";

/**
 * Regression for can1357/oh-my-pi#15767 (reproducer and diagnosis by @shoucandanghehe).
 * File-backed internal URLs must pass ?q= to the same JSON reader used by
 * physical paths; the file locator intentionally returns a query-free path.
 */
test("local:// and artifact:// JSON queries match their physical file reads", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-internal-"));
	const artifactsDir = path.join(root, "artifacts");
	const localProtocolOptions = {
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => path.basename(root),
	};
	const localFiles = [
		{
			name: "events.jsonl",
			content: [
				'{"event":"provider_start","request":"A"}',
				'{"event":"tool_end","request":"B"}',
				'{"event":"provider_start","request":"C"}',
			].join("\n") + "\n",
		},
		{ name: "data.json", content: '[{"request":"A"},{"request":"B"}]' },
	];
	const firstLocalPath = resolveLocalUrlToPath("local://events.jsonl", localProtocolOptions);
	const localRoot = path.dirname(firstLocalPath);
	try {
		await fs.mkdir(artifactsDir, { recursive: true });
		const physicalPaths: string[] = [];
		for (const [id, fixture] of localFiles.entries()) {
			const localPath = resolveLocalUrlToPath(`local://${fixture.name}`, localProtocolOptions);
			await fs.mkdir(path.dirname(localPath), { recursive: true });
			await fs.writeFile(localPath, fixture.content);
			await fs.writeFile(path.join(artifactsDir, `${id}${path.extname(fixture.name)}`), fixture.content);
			physicalPaths.push(localPath);
		}

		const session = {
			cwd: root,
			hasUI: false,
			enableLsp: false,
			settings: Settings.isolated(),
			getSessionFile: () => path.join(root, "session.jsonl"),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactsDir,
			getSessionId: () => path.basename(root),
			localProtocolOptions,
		} as unknown as ConstructorParameters<typeof ReadTool>[0];
		const tool = new ReadTool(session);
		const read = async (target: string): Promise<string> => {
			const result = await tool.execute("json-query-regression", { path: target });
			expect(result.isError).not.toBe(true);
			return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
		};
		const cases = [
			{ id: 0, query: "?q=" + encodeURIComponent('select(.event == "provider_start") | {request}') },
			{ id: 1, query: "?q=.[0:1]&compact=true" },
			{ id: 0, query: "?q=.request&raw=true&offset=1&limit=1" },
		];
		for (const { id, query } of cases) {
			const expected = await read(physicalPaths[id] + query);
			const local = await read(`local://${localFiles[id].name}${query}`);
			const artifact = await read(`artifact://${id}${query}`);
			expect(local).toBe(expected);
			expect(artifact).toBe(expected);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
		await fs.rm(localRoot, { recursive: true, force: true });
	}
});
