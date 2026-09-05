import { describe, expect, test } from "bun:test";
import {
	CAROUSEL_BOTTOM_SAFE,
	CAROUSEL_GAP_BETWEEN,
	CAROUSEL_GAP_OUT,
	computeCarouselLayout,
	HyprlandStageManager,
	type HyprctlResult,
	type HyprctlRunner,
} from "../../src/tools/computer/stage-manager";

interface FakeClient {
	address: string;
	class: string;
	title: string;
	mapped: boolean;
	monitor: number;
	workspace: { id: number; name: string };
	floating: boolean;
	pinned: boolean;
	at: [number, number];
	size: [number, number];
}

class FakeHyprland {
	activeAddress = "0xa";
	readonly activeWorkspace = { id: 1, name: "1" };
	readonly monitors = [
		{
			id: 0,
			name: "eDP-1",
			width: 2880,
			height: 1800,
			x: 0,
			y: 0,
			scale: 2,
			reserved: [0, 70, 0, 0],
		},
	];
	readonly clients: FakeClient[] = [
		{
			address: "0xa",
			class: "kitty",
			title: "Editor",
			mapped: true,
			monitor: 0,
			workspace: { id: 1, name: "1" },
			floating: false,
			pinned: false,
			at: [10, 45],
			size: [1420, 845],
		},
		{
			address: "0xb",
			class: "firefox",
			title: "Docs",
			mapped: true,
			monitor: 0,
			workspace: { id: 2, name: "2" },
			floating: false,
			pinned: false,
			at: [10, 45],
			size: [1420, 845],
		},
		{
			address: "0xc",
			class: "signal",
			title: "Chat",
			mapped: true,
			monitor: 0,
			workspace: { id: 3, name: "3" },
			floating: false,
			pinned: false,
			at: [10, 45],
			size: [1420, 845],
		},
	];
	readonly dispatches: string[][] = [];

	readonly run: HyprctlRunner = async args => {
		if (args[0] === "-j") return this.#json(args[1]);
		this.dispatches.push(args);
		if (args[1]?.startsWith("hl.")) {
			// Accept lua paths used by the manager; apply via legacy mirror when possible.
			const lua = args[1]!;
			if (lua.includes("movetoworkspacesilent") || lua.includes("workspace =")) {
				const workspaceMatch = /workspace = "([^"]+)"/.exec(lua);
				const addressMatch = /address:(0x[0-9a-f]+)/i.exec(lua);
				if (workspaceMatch && addressMatch) {
					return this.#applyMove(addressMatch[1]!.toLowerCase(), workspaceMatch[1]!);
				}
			}
			if (lua.includes("hl.dsp.focus") || lua.includes("focuswindow")) {
				const addressMatch = /address:(0x[0-9a-f]+)/i.exec(lua);
				if (addressMatch) {
					this.activeAddress = addressMatch[1]!.toLowerCase();
					return this.#result("ok");
				}
			}
			if (lua.includes("window.float")) {
				const addressMatch = /address:(0x[0-9a-f]+)/i.exec(lua);
				const enable = lua.includes('"enable"');
				const client = this.clients.find(c => c.address === addressMatch?.[1]?.toLowerCase());
				if (client) client.floating = enable;
				return this.#result("ok");
			}
			if (lua.includes("window.resize")) {
				const addressMatch = /address:(0x[0-9a-f]+)/i.exec(lua);
				const sizeMatch = /x = (\d+), y = (\d+)/.exec(lua);
				const client = this.clients.find(c => c.address === addressMatch?.[1]?.toLowerCase());
				if (client && sizeMatch) {
					client.size = [Number(sizeMatch[1]), Number(sizeMatch[2])];
				}
				return this.#result("ok");
			}
			if (lua.includes("window.move") && lua.includes("x =")) {
				const addressMatch = /address:(0x[0-9a-f]+)/i.exec(lua);
				const posMatch = /x = (-?\d+), y = (-?\d+)/.exec(lua);
				const client = this.clients.find(c => c.address === addressMatch?.[1]?.toLowerCase());
				if (client && posMatch) {
					client.at = [Number(posMatch[1]), Number(posMatch[2])];
				}
				return this.#result("ok");
			}
			if (lua.includes("alter_z") || lua.includes("alterzorder")) {
				return this.#result("ok");
			}
			// Fall through to unsupported so legacy path runs for pure-legacy tests
			return this.#result("Invalid dispatcher");
		}
		if (args[1] === "movetoworkspacesilent") {
			const [workspace, selector] = args[2]!.split(",");
			const address = selector!.replace("address:", "");
			return this.#applyMove(address, workspace!);
		}
		if (args[1] === "focuswindow") {
			this.activeAddress = args[2]!.replace("address:", "");
			return this.#result("ok");
		}
		if (args[1] === "setfloating") {
			const address = args[2]!.replace("address:", "");
			const client = this.clients.find(c => c.address === address);
			if (client) client.floating = true;
			return this.#result("ok");
		}
		if (args[1] === "settiled") {
			const address = args[2]!.replace("address:", "");
			const client = this.clients.find(c => c.address === address);
			if (client) client.floating = false;
			return this.#result("ok");
		}
		if (args[1] === "resizewindowpixel") {
			const [sizePart, selector] = args[2]!.split(",");
			const [, w, h] = sizePart!.split(" ");
			const address = selector!.replace("address:", "");
			const client = this.clients.find(c => c.address === address);
			if (client) client.size = [Number(w), Number(h)];
			return this.#result("ok");
		}
		if (args[1] === "movewindowpixel") {
			const [posPart, selector] = args[2]!.split(",");
			const [, x, y] = posPart!.split(" ");
			const address = selector!.replace("address:", "");
			const client = this.clients.find(c => c.address === address);
			if (client) client.at = [Number(x), Number(y)];
			return this.#result("ok");
		}
		if (args[1] === "alterzorder") {
			return this.#result("ok");
		}
		return this.#result("error: unsupported", 1);
	};

	#applyMove(address: string, workspace: string): HyprctlResult {
		const client = this.clients.find(candidate => candidate.address === address);
		if (!client) return this.#result("error: client not found", 1);
		client.workspace = {
			id: workspace.startsWith("special:") ? -99 : Number(workspace) || client.workspace.id,
			name: workspace,
		};
		return this.#result("ok");
	}

	#json(query: string | undefined): HyprctlResult {
		if (query === "activeworkspace") return this.#result(JSON.stringify(this.activeWorkspace));
		if (query === "activewindow") {
			return this.#result(JSON.stringify(this.clients.find(client => client.address === this.activeAddress)));
		}
		if (query === "clients") return this.#result(JSON.stringify(this.clients));
		if (query === "monitors") return this.#result(JSON.stringify(this.monitors));
		return this.#result("unknown query", 1);
	}

	#result(stdout: string, exitCode = 0): HyprctlResult {
		return { stdout, stderr: "", exitCode };
	}
}

describe("computeCarouselLayout", () => {
	test("centers the active window with outer gaps and side peeks", () => {
		const monitor = {
			id: 0,
			name: "eDP-1",
			x: 0,
			y: 0,
			width: 1440,
			height: 900,
			reserved: [0, 35, 0, 0] as const,
		};
		const layout = computeCarouselLayout({
			monitor,
			memberAddresses: ["0xa", "0xb", "0xc"],
			activeAddress: "0xb",
		});

		expect(layout.active.address).toBe("0xb");
		expect(layout.left?.address).toBe("0xa");
		expect(layout.right?.address).toBe("0xc");
		expect(layout.parkedAddresses).toEqual([]);

		// Active is inset from edges (gap + reserved + bottom safe).
		expect(layout.active.x).toBeGreaterThanOrEqual(CAROUSEL_GAP_OUT);
		expect(layout.active.y).toBeGreaterThanOrEqual(35 + CAROUSEL_GAP_OUT);
		expect(layout.active.x + layout.active.width).toBeLessThanOrEqual(1440 - CAROUSEL_GAP_OUT);
		expect(layout.active.y + layout.active.height).toBeLessThanOrEqual(
			900 - CAROUSEL_BOTTOM_SAFE - CAROUSEL_GAP_OUT + 1,
		);

		// Peeks sit beside active with a gap.
		expect(layout.left!.x + layout.left!.width + CAROUSEL_GAP_BETWEEN).toBeLessThanOrEqual(
			layout.active.x + 1,
		);
		expect(layout.right!.x).toBeGreaterThanOrEqual(layout.active.x + layout.active.width + CAROUSEL_GAP_BETWEEN - 1);
	});

	test("parks non-neighbor members", () => {
		const layout = computeCarouselLayout({
			monitor: {
				id: 0,
				name: "eDP-1",
				x: 0,
				y: 0,
				width: 1440,
				height: 900,
				reserved: [0, 0, 0, 0],
			},
			memberAddresses: ["0xa", "0xb", "0xc", "0xd"],
			activeAddress: "0xa",
		});
		expect(layout.visibleAddresses).toEqual(["0xa", "0xb"]);
		expect(layout.parkedAddresses).toEqual(["0xc", "0xd"]);
		expect(layout.left).toBeNull();
		expect(layout.right?.address).toBe("0xb");
	});
});

describe("HyprlandStageManager", () => {
	test("inspects mapped clients, monitors, and active state", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const snapshot = await manager.inspect();

		expect(snapshot.activeAddress).toBe("0xa");
		expect(snapshot.activeWorkspace).toEqual({ id: 1, name: "1" });
		expect(snapshot.monitors[0]).toMatchObject({ id: 0, width: 1440, height: 900 });
		expect(snapshot.clients.map(client => [client.address, client.focused, client.width])).toEqual([
			["0xa", true, 1420],
			["0xb", false, 1420],
			["0xc", false, 1420],
		]);
	});

	test("creates a carousel stage: floats, centers active, peeks neighbor, parks the rest", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const stage = await manager.create({
			name: "research",
			activeAddress: "0xb",
			memberAddresses: ["0xa", "0xb", "0xc"],
		});

		expect(stage.layout).toBe("carousel");
		expect(stage.activeAddress).toBe("0xb");
		expect(stage.parkedWorkspace).toBe("special:omp-stage-research");

		const byAddr = Object.fromEntries(hyprland.clients.map(c => [c.address, c]));
		// Active + both neighbors stay on the stage workspace (0xb's home is ws 2).
		expect(byAddr["0xa"]!.workspace.name).toBe("2");
		expect(byAddr["0xb"]!.workspace.name).toBe("2");
		expect(byAddr["0xc"]!.workspace.name).toBe("2");
		expect(byAddr["0xa"]!.floating).toBe(true);
		expect(byAddr["0xb"]!.floating).toBe(true);
		expect(byAddr["0xc"]!.floating).toBe(true);

		// Active is smaller than full monitor and roughly centered.
		expect(byAddr["0xb"]!.size[0]).toBeLessThan(1440);
		expect(byAddr["0xb"]!.size[1]).toBeLessThan(900);
		expect(byAddr["0xb"]!.at[0]).toBeGreaterThan(40);
		expect(hyprland.activeAddress).toBe("0xb");
	});

	test("next/prev rotate the carousel and restore baseline geometry", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);
		const baseline = await manager.inspect();

		await manager.create({
			name: "research",
			activeAddress: "0xa",
			memberAddresses: ["0xa", "0xb", "0xc"],
		});

		const next = await manager.next("research");
		expect(next.activeAddress).toBe("0xb");
		expect(hyprland.activeAddress).toBe("0xb");
		expect(hyprland.clients.find(c => c.address === "0xb")!.floating).toBe(true);

		const prev = await manager.prev();
		expect(prev.activeAddress).toBe("0xa");

		const restored = await manager.restore("research");
		expect(manager.list()).toEqual([]);
		// Members return to original workspaces and tiled state.
		expect(hyprland.clients.map(c => [c.address, c.workspace.name, c.floating])).toEqual([
			["0xa", "1", false],
			["0xb", "2", false],
			["0xc", "3", false],
		]);
		expect(restored.clients.map(c => c.address)).toEqual(baseline.clients.map(c => c.address));
	});

	test("isolate layout parks non-active members without floating carousel", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const stage = await manager.create({
			name: "iso",
			activeAddress: "0xa",
			memberAddresses: ["0xa", "0xb"],
			layout: "isolate",
		});
		expect(stage.layout).toBe("isolate");
		expect(hyprland.clients.map(c => [c.address, c.workspace.name, c.floating])).toEqual([
			["0xa", "1", false],
			["0xb", "special:omp-stage-iso", false],
			["0xc", "3", false],
		]);
		await manager.restore("iso");
	});

	test("uses the selected exact address when app and title metadata are not unique", async () => {
		const hyprland = new FakeHyprland();
		hyprland.clients[2]!.class = "firefox";
		hyprland.clients[2]!.title = "Docs";
		const manager = new HyprlandStageManager(hyprland.run);
		const baseline = await manager.inspect();
		const metadataMatches = baseline.clients.filter(client => client.app === "firefox" && client.title === "Docs");
		expect(metadataMatches.map(client => client.address)).toEqual(["0xb", "0xc"]);

		const created = await manager.create({
			name: "exact-address",
			activeAddress: "0xb",
			memberAddresses: ["0xb", "0xa"],
			layout: "isolate",
		});
		expect(created.memberAddresses).toEqual(["0xb", "0xa"]);
		expect(hyprland.activeAddress).toBe("0xb");

		const switched = await manager.switch({ name: "exact-address", activeAddress: "0xa" });
		expect(switched.activeAddress).toBe("0xa");

		const restored = await manager.restore("exact-address");
		expect(restored.clients.find(client => client.address === "0xc")?.app).toBe("firefox");
		expect(hyprland.dispatches.some(args => String(args[2] ?? args[1] ?? "").includes("address:0xc"))).toBe(false);
	});

	test("keeps the selected active member on its own monitor workspace", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const stage = await manager.create({
			name: "detached",
			activeAddress: "0xb",
			memberAddresses: ["0xb", "0xc"],
			layout: "isolate",
		});

		expect(stage.workspace).toEqual({ id: 2, name: "2" });
		expect(hyprland.clients[1]!.workspace.name).toBe("2");
		expect(hyprland.clients[2]!.workspace.name).toBe("special:omp-stage-detached");
		await manager.restore("detached");
	});

	test("rejects stale and pinned members before dispatch", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		await expect(
			manager.create({ name: "stale", activeAddress: "0xa", memberAddresses: ["0xa", "0xff"] }),
		).rejects.toThrow("0xff is not mapped");
		hyprland.clients[1]!.pinned = true;
		await expect(
			manager.create({ name: "pinned", activeAddress: "0xa", memberAddresses: ["0xa", "0xb"] }),
		).rejects.toThrow("0xb is pinned");
		expect(hyprland.dispatches).toEqual([]);
	});
});
