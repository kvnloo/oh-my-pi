import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import * as scraperUtils from "@oh-my-pi/pi-coding-agent/web/scrapers/utils";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function makeSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.${toolType}.log`) };
		},
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

function textOutput(result: { content: Array<TextContent | ImageContent> }): string {
	return result.content
		.filter((content): content is TextContent => content.type === "text")
		.map(content => content.text)
		.join("\n");
}

function uniqueUrl(name: string, extension: string): string {
	return `https://example.com/${name}-${Snowflake.next()}${extension}`;
}

// A mislabeled response: the server declares a convertible (PDF/DOCX/EPUB)
// content type and returns HTTP 200, so shouldSkipBodyDownload tells loadPage
// to skip reading the body (content:"", bodySkipped:true). The real body is
// long-prose HTML whose native-reader markdown clears the low-quality gate.
const MISLABELED_HTML_BODY = `<!doctype html>
<html><head><title>Quarterly operations review</title></head><body>
<h1>Quarterly operations review for the western region division</h1>
<p>This document summarizes the operational milestones achieved during the most recent reporting quarter across all regional teams and partners.</p>
<p>Some important text the user wanted appears here so that the rendered markdown contains a recognizable substring the assertions can rely on.</p>
<p>Production throughput increased by approximately eighteen percent over the prior quarter driven by improved scheduling and reduced downtime across the manufacturing lines.</p>
<p>Regional coordination meetings were held on a weekly cadence to ensure that all field teams remained aligned on the quarterly objectives and the shared delivery roadmap commitments.</p>
<p>Supply chain partners reported stable delivery windows and the logistics group maintained on-time shipment rates above the contractual threshold throughout the entire reporting period under review.</p>
<p>Customer satisfaction surveys indicated positive trends in the western region with net promoter scores climbing steadily and qualitative feedback highlighting responsiveness and reliability improvements.</p>
<p>Looking ahead the division plans to expand the pilot automation program to two additional sites and to invest in cross-training programs that strengthen operational resilience across all shift schedules.</p>
</body></html>`;

const MISLABELED_PLAIN_BODY = `Quarterly operations review for the western region division
This document summarizes the operational milestones achieved during the most recent reporting quarter across all regional teams and partners.
Some important text the user wanted appears here so that the assertions can rely on the recognizable substring.
Production throughput increased by approximately eighteen percent over the prior quarter driven by improved scheduling and reduced downtime across the manufacturing lines.
Regional coordination meetings were held on a weekly cadence to ensure that all field teams remained aligned on the quarterly objectives and the shared delivery roadmap commitments.`;

/**
 * Stub loadPage to return the body-skipped response that
 * shouldSkipBodyDownload produces for a convertible content type:
 * HTTP 200, empty content, bodySkipped: true.
 */
function stubSkippedConvertible(contentType: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: "",
		bodySkipped: true,
	}));
}

describe("read URL mislabeled convertible MIME recovery", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = path.join(os.tmpdir(), `fetch-mislabeled-${Snowflake.next()}`);
		fs.mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(testDir);
	});

	it("renders mislabeled PDF body as HTML instead of dropping it for a binary notice", async () => {
		const url = uniqueUrl("doc", ".pdf");
		stubSkippedConvertible("application/pdf");
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: Buffer.from(MISLABELED_HTML_BODY, "utf-8"),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			content: "",
			ok: false,
			error: "markit: invalid pdf",
		});

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-mislabeled-pdf", { path: url });
		const text = textOutput(result);

		expect(result.details?.method).toBe("native");
		expect(text).toContain("Method: native");
		expect(text).toContain("Some important text the user wanted");
		expect(text).not.toContain("[Binary content:");
		expect(result.details?.notes).toContain("markit conversion failed: markit: invalid pdf");
	});

	it("recovers mislabeled plaintext PDF body to the text path", async () => {
		const url = uniqueUrl("plain", ".pdf");
		stubSkippedConvertible("application/pdf");
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: Buffer.from(MISLABELED_PLAIN_BODY, "utf-8"),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			content: "",
			ok: false,
			error: "markit: invalid pdf",
		});

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-mislabeled-plain", { path: url });
		const text = textOutput(result);
		const method = result.details?.method;

		expect(method === "text" || method === "raw").toBe(true);
		expect(text).toContain("Some important text the user wanted");
		expect(text).not.toContain("[Binary content:");
		expect(result.details?.contentType).toBe("text/plain");
	});

	it("preserves the binary notice for genuine PDF bytes that markit rejects", async () => {
		// Real-ish PDF bytes: magic header plus null bytes and invalid-UTF-8
		// sequences that sampleLooksBinary rejects (so recovery does not fire).
		const pdfBytes = Buffer.from(
			"%PDF-1.4\n\x00\x01\x02\x03\xff\xfe\xfd\xfc\n%%EOF\n\ntrailer garbage\x00\x00",
			"latin1",
		);
		const url = uniqueUrl("real", ".pdf");
		stubSkippedConvertible("application/pdf");
		vi.spyOn(scraperUtils, "fetchBinary").mockResolvedValue({
			ok: true,
			buffer: new Uint8Array(pdfBytes),
		});
		vi.spyOn(scraperUtils, "convertWithMarkit").mockResolvedValue({
			content: "",
			ok: false,
			error: "markit: invalid pdf",
		});

		const tool = new ReadTool(makeSession(testDir));
		const result = await tool.execute("read-url-real-pdf", { path: url });

		expect(result.details?.method).toBe("binary");
		expect(result.details?.contentType).toBe("application/pdf");
		expect(result.details?.notes).toContain("markit conversion failed: markit: invalid pdf");
	});
});
