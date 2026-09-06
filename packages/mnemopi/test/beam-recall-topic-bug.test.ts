import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { recall } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";

type TestBeam = BeamMemoryState & { close(): void };

const beams: TestBeam[] = [];

function makeBeam(): TestBeam {
	const db = new Database(":memory:");
	initBeam(db);
	const beam: TestBeam = {
		db,
		sessionId: "s1",
		authorId: null,
		authorType: null,
		channelId: "s1",
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
		},
		close() {
			db.close();
		},
	};
	beams.push(beam);
	return beam;
}

afterEach(() => {
	while (beams.length > 0) beams.pop()?.close();
});

function insertWorking(beam: TestBeam, id: string, source: string, content: string): void {
	beam.db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', 'general')",
		[id, content, source, "2026-05-30T10:00:00.000Z", beam.sessionId, 0.5, "global"],
	);
}

const QUERY_TIME = "2026-05-30T12:00:00.000Z";

describe("beam recall topic filter (removed dead filter)", () => {
	it("filters by the source column when source is provided", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-source-a", "alpha", "deploy bananas trunk");
		insertWorking(beam, "wm-source-b", "beta", "deploy bananas trunk");

		const byAlpha = await recall(beam, "deploy bananas trunk", 5, {
			queryTime: QUERY_TIME,
			source: "alpha",
		});
		const byBeta = await recall(beam, "deploy bananas trunk", 5, {
			queryTime: QUERY_TIME,
			source: "beta",
		});

		expect(byAlpha.map(r => r.id)).toEqual(["wm-source-a"]);
		expect(byBeta.map(r => r.id)).toEqual(["wm-source-b"]);
	});

	it("does NOT reinterpret a stray topic property as a source filter", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-source-a", "alpha", "deploy bananas trunk");
		insertWorking(beam, "wm-source-b", "beta", "deploy bananas trunk");

		// `topic` is not a recall option. A caller that forwards a stray `topic` through a
		// loosely-typed object (as the legacy facade did) must have it ignored rather than
		// silently re-applied as a second `source = ?` clause. Before the fix this returned
		// only ["wm-source-b"] (topic="beta" matched source="beta"); after the fix both rows
		// survive because no topic filter exists.
		const strayTopicOptions = { queryTime: QUERY_TIME, topic: "beta" };
		const withTopic = await recall(beam, "deploy bananas trunk", 5, strayTopicOptions);

		expect(withTopic.map(r => r.id).sort()).toEqual(["wm-source-a", "wm-source-b"]);
	});

	it("combining source with a stray topic returns only the source match, never an empty set", async () => {
		const beam = makeBeam();
		insertWorking(beam, "wm-source-a", "alpha", "deploy bananas trunk");
		insertWorking(beam, "wm-source-b", "beta", "deploy bananas trunk");

		// Before the fix this produced `source = 'alpha' AND source = 'beta'` and returned [].
		// After the fix the stray topic is ignored and only the source filter applies.
		const mixedOptions = { queryTime: QUERY_TIME, source: "alpha", topic: "beta" };
		const both = await recall(beam, "deploy bananas trunk", 5, mixedOptions);

		expect(both.map(r => r.id)).toEqual(["wm-source-a"]);
	});
});
