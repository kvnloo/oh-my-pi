/** Static expected-extension manifest for z0 operator UX only. */
export interface ExpectedExtension {
	id: string;
	expectedLocation: string;
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
		expectedCommit: "e452c37fbd9bf72f93f704b6ca679a86010e87eb",
	},
	{
		id: "agy-executor",
		expectedLocation: "/home/kvn/tmp/omp-ext-agy-executor",
		expectedCommit: "0ab322140d1a9170c8dcf917bdb4681d04c4e719",
	},
];
