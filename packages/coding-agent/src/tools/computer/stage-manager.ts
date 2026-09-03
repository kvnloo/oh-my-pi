import { ToolError, throwIfAborted } from "../tool-errors";

export interface HyprlandWorkspace {
	id: number;
	name: string;
}

export interface HyprlandStageClient {
	address: string;
	app: string;
	title: string;
	pid?: number;
	monitor: number;
	workspace: HyprlandWorkspace;
	floating: boolean;
	pinned: boolean;
	focused: boolean;
}

export interface HyprlandStageSnapshot {
	activeWorkspace: HyprlandWorkspace;
	activeAddress: string | null;
	clients: HyprlandStageClient[];
}

export interface HyprlandStage {
	name: string;
	workspace: HyprlandWorkspace;
	activeAddress: string;
	memberAddresses: string[];
	parkedWorkspace: string;
}

export interface CreateStageOptions {
	name: string;
	activeAddress: string;
	memberAddresses: string[];
}

export interface SwitchStageOptions {
	name: string;
	activeAddress: string;
}

export interface HyprctlResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export type HyprctlRunner = (args: string[], signal?: AbortSignal) => Promise<HyprctlResult>;

interface StoredStage {
	stage: HyprlandStage;
	baseline: HyprlandStageSnapshot;
}

const ADDRESS_RE = /^0x[0-9a-f]+$/i;
const STAGE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

async function defaultHyprctlRunner(args: string[], signal?: AbortSignal): Promise<HyprctlResult> {
	throwIfAborted(signal);
	const child = Bun.spawn(["hyprctl", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		signal,
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	throwIfAborted(signal);
	return { stdout, stderr, exitCode };
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function booleanValue(value: unknown): boolean {
	return value === true;
}

function parseWorkspace(value: unknown): HyprlandWorkspace {
	const workspace = record(value);
	return {
		id: numberValue(workspace?.id, -1),
		name: stringValue(workspace?.name) || String(numberValue(workspace?.id, -1)),
	};
}

function normalizeAddress(value: unknown): string {
	const address = stringValue(value).toLowerCase();
	if (!ADDRESS_RE.test(address))
		throw new ToolError(`Hyprland returned invalid client address ${JSON.stringify(value)}`);
	return address;
}

function parseClient(value: unknown, activeAddress: string | null): HyprlandStageClient | null {
	const client = record(value);
	if (!client || client.mapped === false || !client.address) return null;
	const address = normalizeAddress(client.address);
	const pid = numberValue(client.pid, -1);
	return {
		address,
		app: stringValue(client.class) || stringValue(client.initialClass) || "unknown",
		title: stringValue(client.title),
		...(pid >= 0 ? { pid } : {}),
		monitor: numberValue(client.monitor, -1),
		workspace: parseWorkspace(client.workspace),
		floating: booleanValue(client.floating),
		pinned: booleanValue(client.pinned),
		focused: address === activeAddress,
	};
}

function luaString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueAddresses(addresses: string[]): string[] {
	const normalized = addresses.map(address => normalizeAddress(address));
	return [...new Set(normalized)];
}

export class HyprlandStageManager {
	readonly #runner: HyprctlRunner;
	readonly #stages = new Map<string, StoredStage>();

	constructor(runner: HyprctlRunner = defaultHyprctlRunner) {
		this.#runner = runner;
	}

	async inspect(signal?: AbortSignal): Promise<HyprlandStageSnapshot> {
		const [workspacePayload, activePayload, clientsPayload] = await Promise.all([
			this.#json(["-j", "activeworkspace"], signal),
			this.#json(["-j", "activewindow"], signal),
			this.#json(["-j", "clients"], signal),
		]);
		const active = record(activePayload);
		const rawAddress = stringValue(active?.address);
		const activeAddress = rawAddress ? normalizeAddress(rawAddress) : null;
		if (!Array.isArray(clientsPayload)) throw new ToolError("hyprctl -j clients returned a non-array");
		const clients = clientsPayload
			.map(value => parseClient(value, activeAddress))
			.filter((client): client is HyprlandStageClient => client !== null);
		return {
			activeWorkspace: parseWorkspace(workspacePayload),
			activeAddress,
			clients,
		};
	}

	list(): HyprlandStage[] {
		return [...this.#stages.values()].map(({ stage }) => structuredClone(stage));
	}

	async create(options: CreateStageOptions, signal?: AbortSignal): Promise<HyprlandStage> {
		const name = this.#stageName(options.name);
		if (this.#stages.has(name)) throw new ToolError(`stage ${JSON.stringify(name)} already exists`);
		const baseline = await this.inspect(signal);
		const members = uniqueAddresses(options.memberAddresses);
		const activeAddress = normalizeAddress(options.activeAddress);
		if (!members.includes(activeAddress)) members.unshift(activeAddress);
		this.#validateMembers(baseline, members);
		const parkedWorkspace = `special:omp-stage-${name}`;
		const stage: HyprlandStage = {
			name,
			workspace: baseline.activeWorkspace,
			activeAddress,
			memberAddresses: members,
			parkedWorkspace,
		};
		try {
			await this.#activate(stage, activeAddress, signal);
			this.#stages.set(name, { stage, baseline });
			return structuredClone(stage);
		} catch (error) {
			await this.#restoreSnapshot(baseline, members, signal).catch(() => undefined);
			throw error;
		}
	}

	async switch(options: SwitchStageOptions, signal?: AbortSignal): Promise<HyprlandStage> {
		const name = this.#stageName(options.name);
		const stored = this.#stages.get(name);
		if (!stored) throw new ToolError(`unknown stage ${JSON.stringify(name)}`);
		const activeAddress = normalizeAddress(options.activeAddress);
		if (!stored.stage.memberAddresses.includes(activeAddress)) {
			throw new ToolError(`client ${activeAddress} is not a member of stage ${JSON.stringify(name)}`);
		}
		const before = await this.inspect(signal);
		this.#validateMembers(before, stored.stage.memberAddresses);
		try {
			await this.#activate(stored.stage, activeAddress, signal);
			stored.stage.activeAddress = activeAddress;
			return structuredClone(stored.stage);
		} catch (error) {
			await this.#restoreSnapshot(before, stored.stage.memberAddresses, signal).catch(() => undefined);
			throw error;
		}
	}

	async restore(nameValue: string, signal?: AbortSignal): Promise<HyprlandStageSnapshot> {
		const name = this.#stageName(nameValue);
		const stored = this.#stages.get(name);
		if (!stored) throw new ToolError(`unknown stage ${JSON.stringify(name)}`);
		await this.#restoreSnapshot(stored.baseline, stored.stage.memberAddresses, signal);
		this.#stages.delete(name);
		return await this.inspect(signal);
	}

	async #activate(stage: HyprlandStage, activeAddress: string, signal?: AbortSignal): Promise<void> {
		for (const address of stage.memberAddresses) {
			if (address === activeAddress) continue;
			await this.#move(address, stage.parkedWorkspace, signal);
			await this.#verifyWorkspace(address, stage.parkedWorkspace, signal);
		}
		await this.#move(activeAddress, stage.workspace.name, signal);
		await this.#verifyWorkspace(activeAddress, stage.workspace.name, signal);
		await this.#focus(activeAddress, signal);
		const verified = await this.inspect(signal);
		if (verified.activeAddress !== activeAddress) {
			throw new ToolError(`Hyprland focused ${verified.activeAddress ?? "no client"}, expected ${activeAddress}`);
		}
	}

	async #restoreSnapshot(
		snapshot: HyprlandStageSnapshot,
		memberAddresses: string[],
		signal?: AbortSignal,
	): Promise<void> {
		const live = await this.inspect(signal);
		const liveAddresses = new Set(live.clients.map(client => client.address));
		const members = new Set(memberAddresses);
		for (const client of snapshot.clients) {
			if (!members.has(client.address) || !liveAddresses.has(client.address)) continue;
			await this.#move(client.address, client.workspace.name, signal);
			await this.#verifyWorkspace(client.address, client.workspace.name, signal);
		}
		if (snapshot.activeAddress && liveAddresses.has(snapshot.activeAddress)) {
			await this.#focus(snapshot.activeAddress, signal);
		}
	}

	async #verifyWorkspace(address: string, expected: string, signal?: AbortSignal): Promise<void> {
		const snapshot = await this.inspect(signal);
		const client = snapshot.clients.find(candidate => candidate.address === address);
		if (!client) throw new ToolError(`Hyprland client ${address} disappeared during stage mutation`);
		if (client.workspace.name !== expected) {
			throw new ToolError(`Hyprland kept ${address} on ${client.workspace.name}, expected ${expected}`);
		}
	}

	#validateMembers(snapshot: HyprlandStageSnapshot, addresses: string[]): void {
		const clients = new Map(snapshot.clients.map(client => [client.address, client]));
		for (const address of addresses) {
			const client = clients.get(address);
			if (!client) throw new ToolError(`Hyprland client ${address} is not mapped`);
			if (client.pinned) throw new ToolError(`Hyprland client ${address} is pinned and cannot be isolated`);
		}
	}

	#stageName(value: string): string {
		const name = value.trim();
		if (!STAGE_NAME_RE.test(name)) {
			throw new ToolError(
				"stage name must start with an alphanumeric and contain only 1-48 alphanumerics, dashes, or underscores",
			);
		}
		return name;
	}

	async #move(address: string, workspace: string, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		await this.#dispatch(
			[`hl.dsp.window.move({ workspace = "${luaString(workspace)}", window = "${selector}" })`],
			["movetoworkspacesilent", `${workspace},${selector}`],
			signal,
		);
	}

	async #focus(address: string, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		await this.#dispatch([`hl.dsp.focus({ window = "${selector}" })`], ["focuswindow", selector], signal);
	}

	async #dispatch(lua: string[], legacy: string[], signal?: AbortSignal): Promise<void> {
		const attempts = [lua, legacy];
		let lastReply = "";
		for (const args of attempts) {
			const result = await this.#runner(["dispatch", ...args], signal);
			lastReply = (result.stdout || result.stderr).trim();
			if (result.exitCode === 0 && lastReply === "ok") return;
			if (!this.#unsupported(lastReply)) break;
		}
		throw new ToolError(`hyprctl dispatch failed: ${lastReply || "no response"}`);
	}

	#unsupported(reply: string): boolean {
		return (
			reply.startsWith("Invalid dispatcher") ||
			reply.startsWith("error:") ||
			reply.includes("attempt to call a nil value")
		);
	}

	async #json(args: string[], signal?: AbortSignal): Promise<unknown> {
		const result = await this.#runner(args, signal);
		if (result.exitCode !== 0) {
			throw new ToolError(`hyprctl ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
		}
		try {
			return JSON.parse(result.stdout) as unknown;
		} catch (error) {
			throw new ToolError(`hyprctl ${args.join(" ")} returned invalid JSON`, { cause: error });
		}
	}
}
