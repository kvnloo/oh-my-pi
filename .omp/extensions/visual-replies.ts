import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolSession } from "@oh-my-pi/pi-coding-agent";

export const MAX_VISUAL_HTML_BYTES = 1_048_576;
const DEFAULT_WIDTH = 1000;
const DEFAULT_HEIGHT = 650;
const NO_NETWORK_DOMAIN = "visual-replies.invalid";
const CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
	"img-src data: blob:",
	"font-src data:",
	"media-src data: blob:",
	"connect-src 'none'",
	"object-src 'none'",
	"frame-src 'none'",
	"base-uri 'none'",
	"form-action 'none'",
].join("; ");
const BASE_STYLE = `
<style id="omp-visual-reply-base">
:root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
html, body { margin: 0; min-width: 0; background: transparent; }
body { box-sizing: border-box; padding: 12px; overflow: auto; }
*, *::before, *::after { box-sizing: border-box; }
</style>`;

interface BrowserResult {
	content: Array<{ type: string; [key: string]: unknown }>;
	details?: unknown;
	isError?: boolean;
}

interface VisualDiagnostics {
	console: unknown;
	errors: unknown;
}

let latestVisualPath: string | undefined;
const openVisualTabs = new Set<string>();

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function validateVisualHtml(html: string): string {
	const value = html.trim();
	if (!value) throw new Error("Visual HTML cannot be empty");
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > MAX_VISUAL_HTML_BYTES) {
		throw new Error(`Visual HTML is ${bytes} bytes; limit is ${MAX_VISUAL_HTML_BYTES}`);
	}
	return value;
}

export function prepareVisualDocument(html: string, title = "OMP visual reply"): string {
	const source = validateVisualHtml(html);
	const injected = [
		'<meta charset="utf-8">',
		`<meta http-equiv="Content-Security-Policy" content="${escapeHtml(CSP)}">`,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(title)}</title>`,
		BASE_STYLE,
	].join("\n");

	if (/<head(?:\s[^>]*)?>/i.test(source)) {
		return source.replace(/<head(?:\s[^>]*)?>/i, match => `${match}\n${injected}`);
	}
	if (/<html(?:\s[^>]*)?>/i.test(source)) {
		return source.replace(/<html(?:\s[^>]*)?>/i, match => `${match}\n<head>${injected}</head>`);
	}
	return `<!doctype html><html><head>${injected}</head><body>${source}</body></html>`;
}

export function visualDataUrl(document: string): string {
	return `data:text/html;charset=utf-8,${encodeURIComponent(document)}`;
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value!)));
}

function browserSession(pi: ExtensionAPI, ctx: ExtensionContext): ToolSession {
	return {
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: pi.pi.settings,
	};
}

async function invokeBrowser(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: unknown,
	toolCallId: string,
	signal?: AbortSignal,
): Promise<BrowserResult> {
	const session = browserSession(pi, ctx);
	const prelude = pi.pi.createBrowserPrelude(session);
	return (await prelude.invoke(params, { session, toolCallId, signal })) as BrowserResult;
}

function detailValue<T>(result: BrowserResult): T | undefined {
	if (!result.details || typeof result.details !== "object" || !("value" in result.details)) return undefined;
	return (result.details as { value?: T }).value;
}

async function captureVisual(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	document: string,
	toolCallId: string,
	signal: AbortSignal | undefined,
	width: number,
	height: number,
): Promise<{ screenshot: BrowserResult; diagnostics: VisualDiagnostics }> {
	const name = `visual-preview-${crypto.randomUUID()}`;
	await invokeBrowser(
		pi,
		ctx,
		{
			action: "open",
			name,
			url: visualDataUrl(document),
			viewport: { width, height },
			headed: false,
			app: { tern: false },
			allowed_domains: [NO_NETWORK_DOMAIN],
		},
		`${toolCallId}:open`,
		signal,
	);
	try {
		const screenshot = await invokeBrowser(
			pi,
			ctx,
			{ action: "call", name, chain: [{ method: "screenshot", args: [{ fullPage: true }] }] },
			`${toolCallId}:shot`,
			signal,
		);
		const consoleResult = await invokeBrowser(
			pi,
			ctx,
			{ action: "call", name, chain: [{ method: "console", args: [{ limit: 40 }] }] },
			`${toolCallId}:console`,
			signal,
		);
		const errorResult = await invokeBrowser(
			pi,
			ctx,
			{ action: "call", name, chain: [{ method: "errors", args: [{ limit: 40 }] }] },
			`${toolCallId}:errors`,
			signal,
		);
		return {
			screenshot,
			diagnostics: {
				console: detailValue(consoleResult),
				errors: detailValue(errorResult),
			},
		};
	} finally {
		await invokeBrowser(pi, ctx, { action: "close", name }, `${toolCallId}:close`, signal).catch(() => undefined);
	}
}

function diagnosticsSummary(diagnostics: VisualDiagnostics): string {
	const entries = (value: unknown): number => {
		if (!value || typeof value !== "object") return 0;
		const maybe = (value as { entries?: unknown }).entries;
		return Array.isArray(maybe) ? maybe.length : 0;
	};
	const errorCount = entries(diagnostics.errors);
	const consoleCount = entries(diagnostics.console);
	return `${errorCount} page error(s), ${consoleCount} console entr${consoleCount === 1 ? "y" : "ies"}`;
}

async function persistVisual(pi: ExtensionAPI, document: string): Promise<{ id: string; path: string }> {
	const id = crypto.randomUUID();
	const dir = join(pi.pi.getAgentDir(), "visual-replies");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${id}.html`);
	await Bun.write(path, document);
	latestVisualPath = path;
	return { id, path };
}

async function openInteractive(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	document: string,
	id: string,
	width: number,
	height: number,
): Promise<string> {
	const name = `visual-${id}`;
	await invokeBrowser(
		pi,
		ctx,
		{
			action: "open",
			name,
			url: visualDataUrl(document),
			viewport: { width, height },
			app: { tern: true },
			allowed_domains: [NO_NETWORK_DOMAIN],
			persist: true,
		},
		`visual-open:${id}`,
	);
	openVisualTabs.add(name);
	return name;
}

export default function visualReplies(pi: ExtensionAPI): void {
	const z = pi.zod;
	pi.setLabel("Visual replies experiment");

	pi.registerTool({
		name: "html_preview",
		label: "HTML Preview",
		description:
			"Preview a self-contained HTML/CSS/JS visualization before publishing it. Returns a screenshot plus browser console/error diagnostics. Network and local-file access are unavailable; embed every asset. Iterate with this until the visual is correct, then call html_render.",
		parameters: z.object({
			html: z.string().describe("Self-contained HTML document or body fragment"),
			title: z.string().optional().describe("Short preview title"),
			width: z.number().optional().describe("Viewport width in pixels; defaults to 1000"),
			height: z.number().optional().describe("Viewport height in pixels; defaults to 650"),
		}),
		loadMode: "essential",
		approval: "read",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const width = clampDimension(params.width, DEFAULT_WIDTH, 320, 1800);
			const height = clampDimension(params.height, DEFAULT_HEIGHT, 240, 1400);
			const document = prepareVisualDocument(params.html, params.title ?? "OMP visual preview");
			const { screenshot, diagnostics } = await captureVisual(pi, ctx, document, toolCallId, signal, width, height);
			return {
				content: [
					{ type: "text", text: `Preview ${width}×${height}: ${diagnosticsSummary(diagnostics)}.` },
					...screenshot.content,
				],
				details: { kind: "visual-preview", width, height, diagnostics },
			};
		},
	});

	pi.registerTool({
		name: "html_render",
		label: "HTML Render",
		description:
			"Publish a final self-contained visual reply after html_preview. Stores the HTML under the OMP agent directory and returns a transcript screenshot. Set open_interactive=true inside Tern to also open the live HTML/JS page as a Tern browser PiP. External network requests are blocked.",
		parameters: z.object({
			html: z.string().describe("Final self-contained HTML document or body fragment"),
			title: z.string().optional().describe("Short visual title"),
			width: z.number().optional().describe("Viewport width in pixels; defaults to 1000"),
			height: z.number().optional().describe("Viewport height in pixels; defaults to 650"),
			open_interactive: z.boolean().optional().describe("Open the live visual in a Tern PiP after publishing"),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const width = clampDimension(params.width, DEFAULT_WIDTH, 320, 1800);
			const height = clampDimension(params.height, DEFAULT_HEIGHT, 240, 1400);
			const document = prepareVisualDocument(params.html, params.title ?? "OMP visual reply");
			const { screenshot, diagnostics } = await captureVisual(pi, ctx, document, toolCallId, signal, width, height);
			const saved = await persistVisual(pi, document);
			let interactive: string | undefined;
			if (params.open_interactive) {
				if (!process.env.TERN_PANE_SOCKET || !process.env.TERN_PANE) {
					interactive = "requested, but this OMP process is not running inside a Tern pane";
				} else {
					const name = await openInteractive(pi, ctx, document, saved.id, width, height);
					interactive = `opened as ${name}`;
				}
			}
			return {
				content: [
					{
						type: "text",
						text: `Published visual ${saved.id}. ${diagnosticsSummary(diagnostics)}.${interactive ? ` Interactive: ${interactive}.` : ""}`,
					},
					...screenshot.content,
				],
				details: {
					kind: "visual-reply",
					id: saved.id,
					path: saved.path,
					width,
					height,
					diagnostics,
					interactive,
				},
			};
		},
	});

	pi.registerCommand("visual", {
		description: "Open the latest rendered visual reply as a live Tern PiP",
		handler: async (args, ctx) => {
			if (!process.env.TERN_PANE_SOCKET || !process.env.TERN_PANE) {
				ctx.ui.notify("/visual requires OMP running inside Tern", "warning");
				return;
			}
			const requested = args.trim();
			const dir = join(pi.pi.getAgentDir(), "visual-replies");
			const path = requested ? join(dir, `${requested.replace(/\.html$/i, "")}.html`) : latestVisualPath;
			if (!path) {
				ctx.ui.notify("No visual reply has been rendered in this process yet", "warning");
				return;
			}
			try {
				const document = validateVisualHtml(await Bun.file(path).text());
				const id = path.split(/[\\/]/).at(-1)?.replace(/\.html$/i, "") ?? crypto.randomUUID();
				await openInteractive(pi, ctx, document, id, DEFAULT_WIDTH, DEFAULT_HEIGHT);
				ctx.ui.notify(`Opened visual ${id}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not open visual: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("visual-close", {
		description: "Close Tern PiPs opened by the visual replies experiment",
		handler: async (_args, ctx) => {
			let closed = 0;
			for (const name of [...openVisualTabs]) {
				try {
					await invokeBrowser(pi, ctx, { action: "close", name }, `visual-close:${name}`);
					closed++;
				} finally {
					openVisualTabs.delete(name);
				}
			}
			ctx.ui.notify(`Closed ${closed} visual PiP${closed === 1 ? "" : "s"}`, "info");
		},
	});
}
