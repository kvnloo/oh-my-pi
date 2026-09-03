import { describe, expect, test } from "bun:test";
import { HyprlandStageManager, type HyprctlResult, type HyprctlRunner } from "../../src/tools/computer/stage-manager";

interface FakeClient {
	address: string;
	class: string;
	title: string;
	mapped: boolean;
	monitor: number;
	workspace: { id: number; name: string };
	floating: boolean;
	pinned: boolean;
}

class FakeHyprland {
	activeAddress = "0xa";
	readonly activeWorkspace = { id: 1, name: "1" };
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
		},
	];
	readonly dispatches: string[][] = [];

	readonly run: HyprctlRunner = async args => {
		if (args[0] === "-j") return this.#json(args[1]);
		this.dispatches.push(args);
		if (args[1]?.startsWith("hl.")) return this.#result("Invalid dispatcher");
		if (args[1] === "movetoworkspacesilent") {
			const [workspace, selector] = args[2]!.split(",");
			const address = selector!.replace("address:", "");
			const client = this.clients.find(candidate => candidate.address === address);
			if (!client) return this.#result("error: client not found", 1);
			client.workspace = { id: workspace!.startsWith("special:") ? -99 : Number(workspace), name: workspace! };
			return this.#result("ok");
		}
		if (args[1] === "focuswindow") {
			this.activeAddress = args[2]!.replace("address:", "");
			return this.#result("ok");
		}
		return this.#result("error: unsupported", 1);
	};

	#json(query: string | undefined): HyprctlResult {
		if (query === "activeworkspace") return this.#result(JSON.stringify(this.activeWorkspace));
		if (query === "activewindow") {
			return this.#result(JSON.stringify(this.clients.find(client => client.address === this.activeAddress)));
		}
		if (query === "clients") return this.#result(JSON.stringify(this.clients));
		return this.#result("unknown query", 1);
	}

	#result(stdout: string, exitCode = 0): HyprctlResult {
		return { stdout, stderr: "", exitCode };
	}
}

describe("HyprlandStageManager", () => {
	test("inspects mapped clients and active state", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const snapshot = await manager.inspect();

		expect(snapshot.activeAddress).toBe("0xa");
		expect(snapshot.activeWorkspace).toEqual({ id: 1, name: "1" });
		expect(snapshot.clients.map(client => [client.address, client.focused])).toEqual([
			["0xa", true],
			["0xb", false],
			["0xc", false],
		]);
	});

	test("creates, switches, and restores a reversible stage", async () => {
		const hyprland = new FakeHyprland();
		const manager = new HyprlandStageManager(hyprland.run);

		const stage = await manager.create({
			name: "research",
			activeAddress: "0xa",
			memberAddresses: ["0xa", "0xb"],
		});
		expect(stage.parkedWorkspace).toBe("special:omp-stage-research");
		expect(hyprland.clients[0]!.workspace.name).toBe("1");
		expect(hyprland.clients[1]!.workspace.name).toBe("special:omp-stage-research");
		expect(hyprland.clients[2]!.workspace.name).toBe("3");

		await manager.switch({ name: "research", activeAddress: "0xb" });
		expect(hyprland.clients[0]!.workspace.name).toBe("special:omp-stage-research");
		expect(hyprland.clients[1]!.workspace.name).toBe("1");
		expect(hyprland.activeAddress).toBe("0xb");

		const restored = await manager.restore("research");
		expect(restored.clients.map(client => [client.address, client.workspace.name])).toEqual([
			["0xa", "1"],
			["0xb", "2"],
			["0xc", "3"],
		]);
		expect(restored.activeAddress).toBe("0xa");
		expect(manager.list()).toEqual([]);
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
