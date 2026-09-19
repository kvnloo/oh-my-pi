/** Static expected-extension manifest for z0 operator UX only. */
export interface ExpectedExtension {
	id: string;
	expectedLocation: string;
	/** Full or prefix git SHA of the package HEAD we want sessions to run. */
	expectedCommit?: string;
}

export type ExtensionPresence = "ACTIVE" | "STALE" | "MISSING" | "UNKNOWN";

export const EXPECTED_EXTENSIONS: ExpectedExtension[] = [
	{
		id: "z0-live-runtime",
		expectedLocation: "/home/kvn/tmp/omp-ext-z0-live-runtime",
	},
	{
		id: "cognitive-state",
		expectedLocation: "/home/kvn/tmp/omp-ext-cognitive-state",
		expectedCommit: "ce151e54b240c016ee3d666d86520a99028b242b",
	},
	{
		id: "agy-executor",
		expectedLocation: "/home/kvn/tmp/omp-ext-agy-executor",
		// P0.6 everyday manual lane
		expectedCommit: "a1686ceed36731da83346fcd5c7d3418406d8cf6",
	},
];

export function commitMatches(actual: string | undefined, expected: string | undefined): boolean {
	if (!expected) return true;
	if (!actual) return false;
	const a = actual.toLowerCase();
	const e = expected.toLowerCase();
	return a === e || a.startsWith(e) || e.startsWith(a);
}
