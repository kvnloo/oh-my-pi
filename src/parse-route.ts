import type { ExecutorLane } from "./types.ts";

export interface ParsedAgyRoute {
	lane: "AGY_RESEARCH" | "AGY_IMPLEMENT";
	prompt: string;
	explicit: true;
}

const PATTERNS: Array<{ re: RegExp; lane: ParsedAgyRoute["lane"] }> = [
	{ re: /^\s*\/agy\s+research(?:\s+|$)([\s\S]*)$/i, lane: "AGY_RESEARCH" },
	{ re: /^\s*\/agy\s+implement(?:\s+|$)([\s\S]*)$/i, lane: "AGY_IMPLEMENT" },
	{ re: /^\s*\/agy\s+r(?:esearch)?(?:\s+|$)([\s\S]*)$/i, lane: "AGY_RESEARCH" },
	{ re: /^\s*\/agy\s+i(?:mplement)?(?:\s+|$)([\s\S]*)$/i, lane: "AGY_IMPLEMENT" },
	{ re: /^\s*agy:r(?:esearch)?\s+([\s\S]+)$/i, lane: "AGY_RESEARCH" },
	{ re: /^\s*agy:i(?:mplement)?\s+([\s\S]+)$/i, lane: "AGY_IMPLEMENT" },
];

export function parseAgyRoute(text: string): ParsedAgyRoute | null {
	for (const { re, lane } of PATTERNS) {
		const m = text.match(re);
		if (!m) continue;
		const prompt = (m[1] ?? "").trim();
		if (!prompt) return null;
		return { lane, prompt, explicit: true };
	}
	return null;
}

export function isAgyFrontDoor(text: string): boolean {
	return parseAgyRoute(text) !== null;
}

export function laneToRole(lane: ExecutorLane): "research" | "implementation" | "omp" {
	if (lane === "AGY_RESEARCH") return "research";
	if (lane === "AGY_IMPLEMENT") return "implementation";
	return "omp";
}
