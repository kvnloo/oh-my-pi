type JsonObject = Record<string, unknown>;

export interface OmnaraConnection {
	baseUrl: string;
	token: string;
	orgID: string;
	projectID: string;
	agentID: string;
}

export interface OmnaraSseFrame {
	event: string;
	id?: string;
	data: string;
}

export interface OmnaraStreamState {
	state: "connected" | "reconnecting";
	reconnected?: boolean;
}

export interface OmnaraStreamOptions {
	afterSequence?: number;
	signal?: AbortSignal;
	onConnectionStateChange?: (state: OmnaraStreamState) => void;
}

export interface OmnaraInputMedia {
	data: string;
	mediaType: string;
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error("Set " + name);
	return value;
}

export function omnaraConnectionFromEnv(): OmnaraConnection {
	return {
		baseUrl: (process.env.OMNARA_API?.trim() || "https://api.omnara.com/v1").replace(/\/+$/, ""),
		token: requireEnv("OMNARA_TOKEN"),
		orgID: requireEnv("OMNARA_ORG_ID"),
		projectID: requireEnv("OMNARA_PROJECT_ID"),
		agentID: requireEnv("OMNARA_AGENT_ID"),
	};
}

export class SseParser {
	#buffer = "";

	push(chunk: string): OmnaraSseFrame[] {
		this.#buffer += chunk;
		const frames: OmnaraSseFrame[] = [];

		for (;;) {
			const boundary = this.#findBoundary();
			if (!boundary) break;

			const raw = this.#buffer.slice(0, boundary.index);
			this.#buffer = this.#buffer.slice(boundary.index + boundary.length);
			const frame = this.#parseEvent(raw);
			if (frame) frames.push(frame);
		}

		return frames;
	}

	#findBoundary(): { index: number; length: number } | undefined {
		const matches = [
			{ index: this.#buffer.indexOf("\r\n\r\n"), length: 4 },
			{ index: this.#buffer.indexOf("\n\n"), length: 2 },
			{ index: this.#buffer.indexOf("\r\r"), length: 2 },
		].filter(candidate => candidate.index >= 0);

		if (!matches.length) return undefined;
		return matches.reduce((best, candidate) => (candidate.index < best.index ? candidate : best));
	}

	#parseEvent(raw: string): OmnaraSseFrame | undefined {
		let event = "message";
		let id: string | undefined;
		const data: string[] = [];

		for (const line of raw.split(/\r\n|\n|\r/)) {
			if (!line || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);

			if (field === "event") event = value;
			else if (field === "id") id = value;
			else if (field === "data") data.push(value);
		}

		if (!data.length) return undefined;
		return { event, id, data: data.join("\n") };
	}
}

function asObject(value: unknown): JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function apiError(response: Response, body: unknown): Error {
	const object = asObject(body);
	const nested = asObject(object.error);
	const message =
		(typeof nested.message === "string" && nested.message) ||
		(typeof object.message === "string" && object.message) ||
		response.statusText ||
		"Omnara API request failed";
	const code =
		(typeof nested.code === "string" && nested.code) ||
		(typeof object.code === "string" && object.code) ||
		String(response.status);
	return new Error("Omnara " + code + ": " + message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export class OmnaraClient {
	readonly connection: OmnaraConnection;

	constructor(connection: OmnaraConnection = omnaraConnectionFromEnv()) {
		this.connection = connection;
	}

	get agentID(): string {
		return this.connection.agentID;
	}

	#agentPath(path = ""): string {
		const { baseUrl, orgID, projectID, agentID } = this.connection;
		return (
			baseUrl +
			"/orgs/" +
			encodeURIComponent(orgID) +
			"/projects/" +
			encodeURIComponent(projectID) +
			"/agents/" +
			encodeURIComponent(agentID) +
			path
		);
	}

	async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
		return this.#requestAbsolute<T>(this.#agentPath(path), init);
	}

	async #requestAbsolute<T>(url: string, init: RequestInit = {}): Promise<T> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", "Bearer " + this.connection.token);
		headers.set("Accept", "application/json");
		if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

		const response = await fetch(url, { ...init, headers });
		const text = await response.text();
		let body: unknown = {};
		if (text) {
			try {
				body = JSON.parse(text);
			} catch {
				body = { message: text };
			}
		}
		if (!response.ok) throw apiError(response, body);
		return body as T;
	}

	getAgent<T = JsonObject>(): Promise<T> {
		return this.#request<T>("");
	}

	listRecentEvents<T = JsonObject>(limit = 100): Promise<T> {
		return this.#request<T>("/events?before_sequence=0&limit=" + Math.max(1, Math.min(500, Math.trunc(limit))));
	}

	listToolCalls<T = JsonObject>(): Promise<T> {
		return this.#request<T>("/tool-calls?include_subagents=true&limit=500");
	}

	listOpenInteractions<T = JsonObject>(): Promise<T> {
		return this.#request<T>("/interactions?state=open&include_subagents=true&limit=500");
	}

	createInput<T = JsonObject>(
		text: string,
		idempotencyKey: string,
		deliveryMode: "queued" | "steering" = "queued",
		media: readonly OmnaraInputMedia[] = [],
	): Promise<T> {
		const supportedMedia = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
		for (const item of media) {
			if (!supportedMedia.has(item.mediaType)) {
				throw new Error("Omnara backend experiment does not support image type " + item.mediaType);
			}
		}

		// Omnara's own web/CLI surfaces prepend a hidden provenance hint so the
		// agent answers the active UI instead of assuming it should message an integration.
		const contentBlocks: JsonObject[] = [
			{
				type: "text",
				text: "This message came from an OMP terminal frontend connected through Omnara. Respond normally unless the user explicitly asks you to use a messaging integration.",
				metadata: { omnara_hidden: "true" },
			},
			...(text ? [{ type: "text", text }] : []),
			...media.map(item => ({ type: "media", media_type: item.mediaType, data: item.data })),
		];

		return this.#request<T>("/inputs", {
			method: "POST",
			headers: { "Idempotency-Key": idempotencyKey },
			body: JSON.stringify({
				content_blocks: contentBlocks,
				delivery_mode: deliveryMode,
			}),
		});
	}

	cancel<T = JsonObject>(): Promise<T> {
		return this.#request<T>("/cancel", {
			method: "POST",
			body: JSON.stringify({}),
		});
	}

	resolveInteraction<T = JsonObject>(
		interactionAgentID: string,
		interactionID: string,
		answers: Array<{ option_indices: number[]; text?: string }>,
	): Promise<T> {
		const { baseUrl, orgID, projectID } = this.connection;
		const url =
			baseUrl +
			"/orgs/" +
			encodeURIComponent(orgID) +
			"/projects/" +
			encodeURIComponent(projectID) +
			"/agents/" +
			encodeURIComponent(interactionAgentID) +
			"/interactions/" +
			encodeURIComponent(interactionID) +
			"/resolve";
		return this.#requestAbsolute<T>(url, {
			method: "POST",
			body: JSON.stringify({ answers }),
		});
	}

	async *streamEvents(options: OmnaraStreamOptions = {}): AsyncGenerator<OmnaraSseFrame> {
		const signal = options.signal;
		let afterSequence = Math.max(0, Math.trunc(options.afterSequence ?? 0));
		let reconnects = 0;

		while (!signal?.aborted) {
			const url = new URL(this.#agentPath("/events/stream"));
			url.searchParams.set("stream_deltas", "true");
			if (afterSequence > 0) url.searchParams.set("after_sequence", String(afterSequence));

			const headers = new Headers({
				Accept: "text/event-stream",
				Authorization: "Bearer " + this.connection.token,
			});
			if (afterSequence > 0) headers.set("Last-Event-ID", String(afterSequence));

			let response: Response;
			try {
				response = await fetch(url, { headers, signal });
			} catch {
				if (signal?.aborted) return;
				options.onConnectionStateChange?.({ state: "reconnecting", reconnected: reconnects > 0 });
				await sleep(Math.min(5_000, 500 * 2 ** Math.min(reconnects, 4)), signal);
				reconnects++;
				continue;
			}

			if (!response.ok || !response.body) {
				let body: unknown = {};
				try {
					body = JSON.parse(await response.text());
				} catch {
					// Keep the HTTP status as the fallback diagnostic.
				}
				if (response.status >= 500) {
					options.onConnectionStateChange?.({ state: "reconnecting", reconnected: reconnects > 0 });
					await sleep(Math.min(5_000, 500 * 2 ** Math.min(reconnects, 4)), signal);
					reconnects++;
					continue;
				}
				throw apiError(response, body);
			}

			options.onConnectionStateChange?.({ state: "connected", reconnected: reconnects > 0 });
			reconnects = 0;
			const parser = new SseParser();
			const decoder = new TextDecoder();
			const reader = response.body.getReader();
			let retry = true;

			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
						const sequence = frame.id === undefined ? NaN : Number(frame.id);
						if (Number.isSafeInteger(sequence) && sequence > afterSequence) afterSequence = sequence;

						if (frame.event === "error") {
							let body: unknown = {};
							try {
								body = JSON.parse(frame.data);
							} catch {
								body = {};
							}
							const object = asObject(body);
							const nested = asObject(object.error);
							const code =
								(typeof object.code === "string" && object.code) ||
								(typeof nested.code === "string" && nested.code);
							if (code !== "service_unavailable") {
								retry = false;
								throw new Error(
									"Omnara stream error" +
										(code ? " (" + code + ")" : "") +
										": " +
										(typeof object.message === "string" ? object.message : frame.data),
								);
							}
							break;
						}

						yield frame;
					}
				}
			} finally {
				reader.releaseLock();
			}

			if (!retry || signal?.aborted) return;
			options.onConnectionStateChange?.({ state: "reconnecting", reconnected: true });
			await sleep(500, signal);
		}
	}
}
