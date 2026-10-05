/** Keep Cargo's profile selection and napi-rs's artifact directory in agreement. */
export function napiCargoProfileArgs(profile?: string): string[] {
	const selected = profile?.trim() || "local";
	// Cargo writes its built-in dev profile to debug/, but napi-rs treats an
	// explicit profile as the directory name. Both defaults agree on debug/.
	return selected === "dev" ? [] : ["--profile", selected];
}
