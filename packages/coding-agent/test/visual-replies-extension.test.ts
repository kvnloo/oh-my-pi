import { describe, expect, it } from "bun:test";
import {
	MAX_VISUAL_HTML_BYTES,
	prepareVisualDocument,
	validateVisualHtml,
	visualDataUrl,
} from "../../../.omp/extensions/visual-replies";

describe("visual replies experiment", () => {
	it("wraps fragments with a restrictive self-contained document shell", () => {
		const document = prepareVisualDocument("<main>Hello</main>", "Demo");
		expect(document).toContain("<!doctype html>");
		expect(document).toContain("Content-Security-Policy");
		expect(document).toContain("connect-src 'none'");
		expect(document).toContain("frame-src 'none'");
		expect(document).toContain("<title>Demo</title>");
		expect(document).toContain("<main>Hello</main>");
	});

	it("injects the sandbox policy into an existing head", () => {
		const document = prepareVisualDocument(
			"<!doctype html><html><head><style>.x{}</style></head><body>ok</body></html>",
		);
		expect(document.match(/Content-Security-Policy/g)).toHaveLength(1);
		expect(document.indexOf("Content-Security-Policy")).toBeLessThan(document.indexOf("<style>.x{}"));
	});

	it("escapes titles before inserting them", () => {
		const document = prepareVisualDocument("<p>ok</p>", '<img src=x onerror="boom">');
		expect(document).not.toContain('<title><img src=x onerror="boom"></title>');
		expect(document).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;");
	});

	it("rejects empty and over-limit documents", () => {
		expect(() => validateVisualHtml("   ")).toThrow("cannot be empty");
		expect(() => validateVisualHtml("x".repeat(MAX_VISUAL_HTML_BYTES + 1))).toThrow("limit");
	});

	it("encodes the prepared document as a data URL", () => {
		const document = prepareVisualDocument("<b>hello world</b>");
		const url = visualDataUrl(document);
		expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
		expect(decodeURIComponent(url.split(",", 2)[1] ?? "")).toBe(document);
	});
});
