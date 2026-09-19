/** Cheap deterministic token estimate (~4 chars / token). */
export function estimateTokens(text: string): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateJsonTokens(value: unknown): number {
	return estimateTokens(JSON.stringify(value));
}
