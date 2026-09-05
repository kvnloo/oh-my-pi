import { ToolError, throwIfAborted } from "../tool-errors";
import { buildGatedHyprExecExpression, readE2eIsolationTarget } from "./e2e-isolation";

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
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface HyprlandMonitorGeometry {
	id: number;
	name: string;
	/** Logical origin (hyprctl clients `at` space). */
	x: number;
	y: number;
	/** Logical size (physical ÷ scale). */
	width: number;
	height: number;
	/** reserved: [left, top, right, bottom] in logical px. */
	reserved: readonly [number, number, number, number];
}

export interface HyprlandStageSnapshot {
	activeWorkspace: HyprlandWorkspace;
	activeAddress: string | null;
	clients: HyprlandStageClient[];
	monitors: HyprlandMonitorGeometry[];
}

export type StageLayoutMode = "carousel" | "isolate";

export interface HyprlandStage {
	name: string;
	workspace: HyprlandWorkspace;
	activeAddress: string;
	memberAddresses: string[];
	parkedWorkspace: string;
	/** Felix-style floating carousel is the default. */
	layout: StageLayoutMode;
	monitorId: number;
}

export interface CreateStageOptions {
	name: string;
	activeAddress: string;
	memberAddresses: string[];
	/** Default `carousel` — center active with gaps + left/right peeks. */
	layout?: StageLayoutMode;
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

interface ClientBaseline {
	workspace: HyprlandWorkspace;
	floating: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	monitor: number;
}

interface StoredStage {
	stage: HyprlandStage;
	/** Full inspect snapshot taken before create. */
	baseline: HyprlandStageSnapshot;
	/** Per-member geometry/float/workspace for precise restore. */
	memberBaselines: Map<string, ClientBaseline>;
}

export interface CarouselSlot {
	role: "active" | "left" | "right";
	address: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CarouselLayout {
	monitor: HyprlandMonitorGeometry;
	active: CarouselSlot;
	left: CarouselSlot | null;
	right: CarouselSlot | null;
	/** Addresses moved onto the stage workspace for this layout. */
	visibleAddresses: string[];
	/** Addresses parked on the stage special workspace. */
	parkedAddresses: string[];
}

/** Outer margin around the carousel cluster (logical px). */
export const CAROUSEL_GAP_OUT = 40;
/** Gap between active and peek windows (logical px). */
export const CAROUSEL_GAP_BETWEEN = 28;
/** Keep clear of the Handsfree bar (~70) + placement margin. */
export const CAROUSEL_BOTTOM_SAFE = 86;
/** Active window as a fraction of usable monitor area. */
export const CAROUSEL_ACTIVE_WIDTH_FRAC = 0.72;
export const CAROUSEL_ACTIVE_HEIGHT_FRAC = 0.82;
/** How much of a peek window stays on-screen (fraction of monitor width). */
export const CAROUSEL_PEEK_VISIBLE_FRAC = 0.14;

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
	if (!ADDRESS_RE.test(address)) {
		throw new ToolError(`Hyprland returned invalid client address ${JSON.stringify(value)}`);
	}
	return address;
}

function parseSizePair(value: unknown): { x: number; y: number } {
	if (Array.isArray(value) && value.length >= 2) {
		return { x: numberValue(value[0]), y: numberValue(value[1]) };
	}
	const obj = record(value);
	if (obj) {
		return {
			x: numberValue(obj.x ?? obj[0 as never]),
			y: numberValue(obj.y ?? obj[1 as never]),
		};
	}
	return { x: 0, y: 0 };
}

function parseClient(value: unknown, activeAddress: string | null): HyprlandStageClient | null {
	const client = record(value);
	if (!client || client.mapped === false || !client.address) return null;
	const address = normalizeAddress(client.address);
	const pid = numberValue(client.pid, -1);
	const at = parseSizePair(client.at);
	const size = parseSizePair(client.size);
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
		x: at.x,
		y: at.y,
		width: size.x,
		height: size.y,
	};
}

/** Prefer plain numberValue for x/y — hyprctl reports logical origin already. */
function parseMonitorGeometry(value: unknown): HyprlandMonitorGeometry | null {
	const monitor = record(value);
	if (!monitor) return null;
	const scale = numberValue(monitor.scale, 1) || 1;
	const physicalW = numberValue(monitor.width);
	const physicalH = numberValue(monitor.height);
	const reservedRaw = Array.isArray(monitor.reserved) ? monitor.reserved : [0, 0, 0, 0];
	const reserved = [0, 1, 2, 3].map(index =>
		Math.round(numberValue(reservedRaw[index]) / scale),
	) as [number, number, number, number];
	return {
		id: numberValue(monitor.id, -1),
		name: stringValue(monitor.name) || `monitor-${numberValue(monitor.id, -1)}`,
		x: numberValue(monitor.x),
		y: numberValue(monitor.y),
		width: Math.round(physicalW / scale),
		height: Math.round(physicalH / scale),
		reserved,
	};
}

function luaString(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function uniqueAddresses(addresses: string[]): string[] {
	const normalized = addresses.map(address => normalizeAddress(address));
	return [...new Set(normalized)];
}

/**
 * Felix-style carousel geometry: large centered active window with outer gaps,
 * optional left/right peeks partially off-screen.
 */
export function computeCarouselLayout(options: {
	monitor: HyprlandMonitorGeometry;
	memberAddresses: string[];
	activeAddress: string;
	gapOut?: number;
	gapBetween?: number;
	bottomSafe?: number;
	activeWidthFrac?: number;
	activeHeightFrac?: number;
	peekVisibleFrac?: number;
}): CarouselLayout {
	const members = options.memberAddresses.map(address => normalizeAddress(address));
	const activeAddress = normalizeAddress(options.activeAddress);
	const activeIndex = members.indexOf(activeAddress);
	if (activeIndex < 0) {
		throw new ToolError(`active address ${activeAddress} is not a stage member`);
	}

	const gapOut = options.gapOut ?? CAROUSEL_GAP_OUT;
	const gapBetween = options.gapBetween ?? CAROUSEL_GAP_BETWEEN;
	const bottomSafe = Math.max(options.bottomSafe ?? CAROUSEL_BOTTOM_SAFE, options.monitor.reserved[3] ?? 0);
	const activeWidthFrac = options.activeWidthFrac ?? CAROUSEL_ACTIVE_WIDTH_FRAC;
	const activeHeightFrac = options.activeHeightFrac ?? CAROUSEL_ACTIVE_HEIGHT_FRAC;
	const peekVisibleFrac = options.peekVisibleFrac ?? CAROUSEL_PEEK_VISIBLE_FRAC;

	const mon = options.monitor;
	const leftR = mon.reserved[0] ?? 0;
	const topR = mon.reserved[1] ?? 0;
	const rightR = mon.reserved[2] ?? 0;

	const usableW = Math.max(320, mon.width - leftR - rightR - gapOut * 2);
	const usableH = Math.max(240, mon.height - topR - bottomSafe - gapOut * 2);
	const activeW = Math.max(280, Math.round(usableW * activeWidthFrac));
	const activeH = Math.max(200, Math.round(usableH * activeHeightFrac));
	const activeX = mon.x + leftR + gapOut + Math.round((usableW - activeW) / 2);
	const activeY = mon.y + topR + gapOut + Math.round((usableH - activeH) / 2);

	const peekW = Math.max(240, Math.round(activeW * 0.92));
	const peekH = Math.max(180, Math.round(activeH * 0.94));
	const peekY = activeY + Math.round((activeH - peekH) / 2);
	const peekVisible = Math.max(96, Math.round(mon.width * peekVisibleFrac));

	const leftAddress = activeIndex > 0 ? members[activeIndex - 1]! : null;
	const rightAddress = activeIndex < members.length - 1 ? members[activeIndex + 1]! : null;

	// Prefer sitting just left of the active window; clamp so a strip stays visible.
	let left: CarouselSlot | null = null;
	if (leftAddress) {
		let x = activeX - gapBetween - peekW;
		const minX = mon.x - peekW + peekVisible;
		const maxX = activeX - gapBetween - peekW; // natural slot
		x = Math.min(maxX, Math.max(minX, x));
		// If natural position already peeks enough, keep it; otherwise force visible strip.
		if (x + peekW < mon.x + peekVisible) {
			x = mon.x - peekW + peekVisible;
		}
		left = { role: "left", address: leftAddress, x, y: peekY, width: peekW, height: peekH };
	}

	let right: CarouselSlot | null = null;
	if (rightAddress) {
		let x = activeX + activeW + gapBetween;
		const maxX = mon.x + mon.width - peekVisible;
		if (x > maxX) {
			x = maxX;
		}
		right = { role: "right", address: rightAddress, x, y: peekY, width: peekW, height: peekH };
	}

	const active: CarouselSlot = {
		role: "active",
		address: activeAddress,
		x: activeX,
		y: activeY,
		width: activeW,
		height: activeH,
	};

	const visibleAddresses = [left?.address, activeAddress, right?.address].filter(
		(address): address is string => Boolean(address),
	);
	const visibleSet = new Set(visibleAddresses);
	const parkedAddresses = members.filter(address => !visibleSet.has(address));

	return {
		monitor: mon,
		active,
		left,
		right,
		visibleAddresses,
		parkedAddresses,
	};
}

export class HyprlandStageManager {
	readonly #runner: HyprctlRunner;
	readonly #stages = new Map<string, StoredStage>();

	constructor(runner: HyprctlRunner = defaultHyprctlRunner) {
		this.#runner = runner;
	}

	async inspect(signal?: AbortSignal): Promise<HyprlandStageSnapshot> {
		const [workspacePayload, activePayload, clientsPayload, monitorsPayload] = await Promise.all([
			this.#json(["-j", "activeworkspace"], signal),
			this.#json(["-j", "activewindow"], signal),
			this.#json(["-j", "clients"], signal),
			this.#json(["-j", "monitors"], signal),
		]);
		const active = record(activePayload);
		const rawAddress = stringValue(active?.address);
		const activeAddress = rawAddress ? normalizeAddress(rawAddress) : null;
		if (!Array.isArray(clientsPayload)) throw new ToolError("hyprctl -j clients returned a non-array");
		if (!Array.isArray(monitorsPayload)) throw new ToolError("hyprctl -j monitors returned a non-array");
		const clients = clientsPayload
			.map(value => parseClient(value, activeAddress))
			.filter((client): client is HyprlandStageClient => client !== null);
		const monitors = monitorsPayload
			.map(value => parseMonitorGeometry(value))
			.filter((monitor): monitor is HyprlandMonitorGeometry => monitor !== null);
		return {
			activeWorkspace: parseWorkspace(workspacePayload),
			activeAddress,
			clients,
			monitors,
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
		const activeClient = baseline.clients.find(client => client.address === activeAddress);
		if (!activeClient) throw new ToolError(`Hyprland client ${activeAddress} is not mapped`);
		const layout = options.layout === "isolate" ? "isolate" : "carousel";
		const parkedWorkspace = `special:omp-stage-${name}`;
		const stage: HyprlandStage = {
			name,
			workspace: activeClient.workspace,
			activeAddress,
			memberAddresses: members,
			parkedWorkspace,
			layout,
			monitorId: activeClient.monitor,
		};
		const memberBaselines = new Map<string, ClientBaseline>();
		for (const address of members) {
			const client = baseline.clients.find(candidate => candidate.address === address)!;
			memberBaselines.set(address, {
				workspace: client.workspace,
				floating: client.floating,
				x: client.x,
				y: client.y,
				width: client.width,
				height: client.height,
				monitor: client.monitor,
			});
		}
		try {
			await this.#activate(stage, activeAddress, signal);
			this.#stages.set(name, { stage, baseline, memberBaselines });
			return structuredClone(stage);
		} catch (error) {
			await this.#restoreMembers(memberBaselines, baseline.activeAddress, signal).catch(() => undefined);
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
			await this.#activate(stored.stage, stored.stage.activeAddress, signal).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * Advance the carousel one step (wraps). Uses the only stage when `name` is omitted.
	 */
	async next(name?: string, signal?: AbortSignal): Promise<HyprlandStage> {
		const stage = this.#requireStage(name);
		const index = stage.memberAddresses.indexOf(stage.activeAddress);
		const nextAddress = stage.memberAddresses[(index + 1) % stage.memberAddresses.length]!;
		return await this.switch({ name: stage.name, activeAddress: nextAddress }, signal);
	}

	/**
	 * Step the carousel backward (wraps). Uses the only stage when `name` is omitted.
	 */
	async prev(name?: string, signal?: AbortSignal): Promise<HyprlandStage> {
		const stage = this.#requireStage(name);
		const index = stage.memberAddresses.indexOf(stage.activeAddress);
		const prevAddress =
			stage.memberAddresses[(index - 1 + stage.memberAddresses.length) % stage.memberAddresses.length]!;
		return await this.switch({ name: stage.name, activeAddress: prevAddress }, signal);
	}

	async restore(nameValue: string, signal?: AbortSignal): Promise<HyprlandStageSnapshot> {
		const name = this.#stageName(nameValue);
		const stored = this.#stages.get(name);
		if (!stored) throw new ToolError(`unknown stage ${JSON.stringify(name)}`);
		await this.#restoreMembers(stored.memberBaselines, stored.baseline.activeAddress, signal);
		this.#stages.delete(name);
		return await this.inspect(signal);
	}

	/**
	 * Launch a shell command onto the handsfree E2E headless target.
	 * Requires OMP_E2E_MONITOR + OMP_E2E_WORKSPACE in the process environment.
	 */
	async execGated(shellCommand: string, signal?: AbortSignal): Promise<{ expression: string }> {
		const command = shellCommand.trim();
		if (!command) throw new ToolError("execGated requires a non-empty shell command");
		const target = readE2eIsolationTarget();
		if (!target) {
			throw new ToolError(
				"execGated requires OMP_E2E_MONITOR and OMP_E2E_WORKSPACE (handsfree E2E isolation)",
			);
		}
		const expression = buildGatedHyprExecExpression(command, target);
		await this.#dispatch([expression], [], signal);
		return { expression };
	}

	#requireStage(name?: string): HyprlandStage {
		if (name !== undefined && name !== null && String(name).trim() !== "") {
			const stored = this.#stages.get(this.#stageName(String(name)));
			if (!stored) throw new ToolError(`unknown stage ${JSON.stringify(name)}`);
			return stored.stage;
		}
		const stages = [...this.#stages.values()];
		if (stages.length === 0) throw new ToolError("no stages exist");
		if (stages.length > 1) {
			throw new ToolError(
				`multiple stages exist (${stages.map(entry => entry.stage.name).join(", ")}); pass a stage name`,
			);
		}
		return stages[0]!.stage;
	}

	async #activate(stage: HyprlandStage, activeAddress: string, signal?: AbortSignal): Promise<void> {
		if (stage.layout === "isolate") {
			await this.#activateIsolate(stage, activeAddress, signal);
			return;
		}
		await this.#activateCarousel(stage, activeAddress, signal);
	}

	async #activateIsolate(stage: HyprlandStage, activeAddress: string, signal?: AbortSignal): Promise<void> {
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

	async #activateCarousel(stage: HyprlandStage, activeAddress: string, signal?: AbortSignal): Promise<void> {
		const snapshot = await this.inspect(signal);
		const monitor =
			snapshot.monitors.find(candidate => candidate.id === stage.monitorId) ??
			snapshot.monitors.find(candidate => candidate.id === snapshot.clients.find(c => c.address === activeAddress)?.monitor) ??
			snapshot.monitors[0];
		if (!monitor) throw new ToolError("Hyprland exposed no monitors for carousel layout");

		const layout = computeCarouselLayout({
			monitor,
			memberAddresses: stage.memberAddresses,
			activeAddress,
		});

		// Park far members first so the workspace only holds the carousel trio.
		for (const address of layout.parkedAddresses) {
			await this.#move(address, stage.parkedWorkspace, signal);
			await this.#verifyWorkspace(address, stage.parkedWorkspace, signal);
		}

		for (const address of layout.visibleAddresses) {
			await this.#move(address, stage.workspace.name, signal);
			await this.#verifyWorkspace(address, stage.workspace.name, signal);
			await this.#setFloating(address, true, signal);
		}

		// Position peeks first, active last so it stacks on top.
		for (const slot of [layout.left, layout.right, layout.active]) {
			if (!slot) continue;
			await this.#resize(slot.address, slot.width, slot.height, signal);
			await this.#movePixel(slot.address, slot.x, slot.y, signal);
		}

		await this.#focus(activeAddress, signal);
		await this.#bringToTop(activeAddress, signal);

		const verified = await this.inspect(signal);
		if (verified.activeAddress !== activeAddress) {
			throw new ToolError(`Hyprland focused ${verified.activeAddress ?? "no client"}, expected ${activeAddress}`);
		}
	}

	async #restoreMembers(
		memberBaselines: Map<string, ClientBaseline>,
		focusAddress: string | null,
		signal?: AbortSignal,
	): Promise<void> {
		const live = await this.inspect(signal);
		const liveAddresses = new Set(live.clients.map(client => client.address));
		for (const [address, baseline] of memberBaselines) {
			if (!liveAddresses.has(address)) continue;
			await this.#move(address, baseline.workspace.name, signal);
			await this.#verifyWorkspace(address, baseline.workspace.name, signal);
			await this.#setFloating(address, baseline.floating, signal);
			if (baseline.width > 0 && baseline.height > 0) {
				await this.#resize(address, baseline.width, baseline.height, signal);
			}
			await this.#movePixel(address, baseline.x, baseline.y, signal);
		}
		if (focusAddress && liveAddresses.has(focusAddress)) {
			await this.#focus(focusAddress, signal);
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

	async #setFloating(address: string, floating: boolean, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		const mode = floating ? "enable" : "disable";
		await this.#dispatch(
			[`hl.dsp.window.float({ action = "${mode}", window = "${selector}" })`],
			// legacy setfloating only enables; togglefloating is ambiguous — prefer settile for disable.
			floating ? ["setfloating", selector] : ["settiled", selector],
			signal,
		);
	}

	async #resize(address: string, width: number, height: number, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		const w = Math.max(1, Math.round(width));
		const h = Math.max(1, Math.round(height));
		await this.#dispatch(
			[`hl.dsp.window.resize({ x = ${w}, y = ${h}, window = "${selector}" })`],
			["resizewindowpixel", `exact ${w} ${h},${selector}`],
			signal,
		);
	}

	async #movePixel(address: string, x: number, y: number, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		const px = Math.round(x);
		const py = Math.round(y);
		await this.#dispatch(
			[`hl.dsp.window.move({ x = ${px}, y = ${py}, window = "${selector}" })`],
			["movewindowpixel", `exact ${px} ${py},${selector}`],
			signal,
		);
	}

	async #bringToTop(address: string, signal?: AbortSignal): Promise<void> {
		const selector = `address:${address}`;
		// Best-effort; missing dispatcher must not fail the carousel.
		try {
			await this.#dispatch(
				[`hl.dsp.window.alter_z({ window = "${selector}", relative = 0 })`],
				["alterzorder", `top,${selector}`],
				signal,
			);
		} catch {
			// ignore
		}
	}

	async #dispatch(lua: string[], legacy: string[], signal?: AbortSignal): Promise<void> {
		const attempts = [lua, legacy];
		let lastReply = "";
		for (const args of attempts) {
			if (args.length === 0) continue;
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

