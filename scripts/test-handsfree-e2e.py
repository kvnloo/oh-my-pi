#!/usr/bin/env python3
"""Isolated Handsfree smoke test for a detached Hyprland output."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Sequence


HUD_LAUNCH_GRACE_SECONDS = 15.0


class HarnessError(RuntimeError):
    pass


class CommandRunner:
    def __init__(self, dry_run: bool, evidence: dict[str, Any]) -> None:
        self.dry_run = dry_run
        self.evidence = evidence

    def run(
        self,
        argv: Sequence[str],
        *,
        timeout: float,
        check: bool = True,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [str(part) for part in argv]
        self.evidence["commands"].append(command)
        if self.dry_run:
            return subprocess.CompletedProcess(command, 0, "", "")
        result = subprocess.run(
            command,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        if check and result.returncode:
            raise HarnessError(
                f"command failed ({result.returncode}): {shlex.join(command)}: {result.stderr.strip()}"
            )
        return result


class HandsfreeHarness:
    def __init__(self, args: argparse.Namespace, runner: CommandRunner | None = None) -> None:
        self.args = args
        suffix = f"{os.getpid()}-{secrets.token_hex(6)}"
        self.token = f"OMP_HANDSFREE_E2E_{suffix}"
        self.output = f"OMP-E2E-{suffix}"
        self.workspace = f"omp-e2e-{suffix}"
        self.deadline = time.monotonic() + args.timeout
        self.cleanup_deadline: float | None = None
        self.evidence: dict[str, Any] = {
            "version": 1,
            "status": "running",
            "dry_run": args.dry_run,
            "token": self.token,
            "output": self.output,
            "workspace": self.workspace,
            "checks": [],
            "cleanup": [],
            "commands": [],
        }
        self.runner = runner or CommandRunner(args.dry_run, self.evidence)
        self.original: dict[str, Any] = {}
        self.output_created = False
        self.output_id: int | None = None
        self.owned_pids: set[int] = set()
        self.log_path = Path(tempfile.gettempdir()) / f"{self.token}.log"
        self.hud_launch_started_at: float | None = None
        self.interrupted: int | None = None

    def remaining(self, deadline: float | None = None, *, floor: float | None = None) -> float:
        end = self.deadline if deadline is None else deadline
        left = end - time.monotonic()
        if left <= 0:
            if floor is not None:
                return floor
            raise HarnessError("harness timeout expired")
        if floor is not None:
            return max(left, floor)
        return left

    def cleanup_remaining(self) -> float:
        if self.cleanup_deadline is None:
            raise HarnessError("cleanup deadline was not initialized")
        return self.remaining(self.cleanup_deadline)

    def check(self, name: str, detail: Any = True) -> None:
        self.evidence["checks"].append({"name": name, "passed": True, "detail": detail})

    def query(self, name: str, *, deadline: float | None = None) -> Any:
        # Keep hyprctl usable near the harness deadline; placement polls often.
        result = self.runner.run(
            ["hyprctl", "-j", name], timeout=self.remaining(deadline, floor=2.0)
        )
        if self.args.dry_run:
            return {} if name.startswith("active") else []
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise HarnessError(f"invalid hyprctl {name} JSON: {error}") from error

    @staticmethod
    def window_snapshot(window: dict[str, Any]) -> dict[str, Any]:
        return {
            "address": window.get("address"),
            "workspace": window.get("workspace"),
            "monitor": window.get("monitor"),
            "at": window.get("at"),
            "size": window.get("size"),
            "floating": window.get("floating"),
            "pinned": window.get("pinned"),
        }

    @staticmethod
    def workspace_identity(workspace: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": workspace.get("id"),
            "name": workspace.get("name"),
        }

    def snapshot_original(self) -> None:
        clients = self.query("clients")
        if not isinstance(clients, list):
            raise HarnessError("hyprctl clients did not return a list")
        clients_by_address: dict[str, Any] = {}
        client_metadata: dict[str, Any] = {}
        for client in clients:
            address = client.get("address")
            if not isinstance(address, str) or not address or address in clients_by_address:
                raise HarnessError("pre-existing clients did not have unique addresses")
            clients_by_address[address] = self.window_snapshot(client)
            client_metadata[address] = {
                "pid": client.get("pid"),
                "class": client.get("class"),
                "title": client.get("title"),
            }
        active_window = self.query("activewindow")
        active_workspace = self.query("activeworkspace")
        self.original = {
            "activewindow": active_window.get("address"),
            "activeworkspace": self.workspace_identity(active_workspace),
            "clients": clients_by_address,
            "client_metadata": client_metadata,
        }
        self.evidence["original"] = self.original
        self.check("original-state-snapshotted", {"client_addresses": sorted(clients_by_address)})
    def create_output(self) -> None:
        self.runner.run(
            ["hyprctl", "output", "create", "headless", self.output], timeout=self.remaining()
        )
        self.output_created = not self.args.dry_run
        if self.args.dry_run:
            self.check("output-create-planned", self.output)
            return
        monitors = self.query("monitors")
        matches = [monitor for monitor in monitors if monitor.get("name") == self.output]
        if len(matches) != 1 or not isinstance(matches[0].get("id"), int):
            raise HarnessError("new output did not resolve to one numeric monitor id")
        self.output_id = matches[0]["id"]
        self.check("output-created", {"name": self.output, "id": self.output_id})

    def dispatch_exec(self, command: list[str]) -> None:
        assignment = (
            f"OMP_HANDSFREE_E2E_TOKEN={shlex.quote(self.token)} "
            f"OMP_HUD_E2E_NO_PIN=1 "
            f"OMP_E2E_MONITOR={shlex.quote(self.output)} "
            f"OMP_E2E_WORKSPACE={shlex.quote(self.workspace)}"
        )
        shell_command = f"env {assignment} {shlex.join(command)}"
        expression = (
            f"hl.dsp.exec_cmd({json.dumps(shell_command)}, "
            f'{{ workspace = "name:{self.workspace}", '
            f'monitor = "{self.output}", no_initial_focus = true }})'
        )
        result = self.runner.run(
            ["hyprctl", "dispatch", expression], timeout=self.remaining()
        )
        if not self.args.dry_run and result.stdout.strip() not in {"", "ok"}:
            response = result.stdout.strip() or result.stderr.strip() or "<empty response>"
            raise HarnessError(f"Hyprland dispatcher rejected launch: {response}")



    def launch(self) -> None:
        fixtures = [
            ("A", f"{self.token} fixture A"),
            ("B", f"{self.token} fixture B"),
        ]
        for label, title in fixtures:
            self.dispatch_exec(
                [
                    "kitty",
                    "--single-instance=no",
                    "--instance-group",
                    f"{self.token}-fixture-{label.lower()}",
                    "--class",
                    f"{self.token}-fixture-{label.lower()}",
                    "--title",
                    title,
                    "sh",
                    "-c",
                    "exec sleep 86400",
                ]
            )
        root = Path(__file__).resolve().parent.parent
        launcher = root / "scripts" / "omp-handsfree"
        command = [str(launcher)]
        self.evidence["hud_launch"] = {
            "command": command,
            "cwd": str(root),
            "log": str(self.log_path),
        }
        self.dispatch_exec(command)
        self.hud_launch_started_at = time.monotonic()
        if self.args.dry_run:
            self.check("launch-planned")

    def token_in_environ(self, pid: int) -> bool:
        try:
            data = Path(f"/proc/{pid}/environ").read_bytes().split(b"\0")
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            return False
        expected = f"OMP_HANDSFREE_E2E_TOKEN={self.token}".encode()
        return expected in data

    def token_processes(self) -> set[int]:
        owned: set[int] = set()
        for entry in Path("/proc").iterdir():
            if entry.name.isdecimal() and self.token_in_environ(int(entry.name)):
                owned.add(int(entry.name))
        return owned
    def hud_launcher_processes(self) -> set[int]:
        launchers: set[int] = set()
        for pid in self.token_processes():
            try:
                command = [
                    argument
                    for argument in Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
                    if argument
                ]
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                continue
            if not command:
                continue
            is_launcher = any(
                Path(argument.decode(errors="surrogateescape")).name == "omp-handsfree"
                for argument in command
            )
            executable = Path(
                command[0].decode(errors="surrogateescape")
            ).name
            is_hud_module = executable.startswith("python") and any(
                argument == b"-m"
                and index + 1 < len(command)
                and command[index + 1] == b"omp_hud"
                for index, argument in enumerate(command)
            )
            if is_launcher or is_hud_module:
                launchers.add(pid)
        return launchers


    def hud_log_text(self) -> str:
        if not self.log_path.is_file():
            return "<HUD log missing>"
        text = self.log_path.read_text(errors="replace")
        return text if text else "<HUD log empty>"



    def token_clients(
        self, *, deadline: float | None = None
    ) -> list[dict[str, Any]]:
        clients = self.query("clients", deadline=deadline)
        if not isinstance(clients, list):
            return []
        return [
            client
            for client in clients
            if isinstance(client.get("pid"), int)
            and self.token_in_environ(client["pid"])
        ]

    def wait_for_clients(self) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        hud_process_seen = False
        while True:
            clients = self.token_clients()
            fixture = [
                client
                for client in clients
                if str(client.get("class", "")).startswith(self.token)
            ]
            non_fixture = [client for client in clients if client not in fixture]
            hud = [
                client
                for client in non_fixture
                if client.get("title") == "OMP Handsfree Mode"
            ]
            if len(non_fixture) == 1 and len(hud) == 1 and len(fixture) == 2:
                break
            hud_processes = self.hud_launcher_processes()
            hud_process_seen = hud_process_seen or bool(hud_processes)
            launch_grace_expired = (
                self.hud_launch_started_at is not None
                and time.monotonic() - self.hud_launch_started_at
                >= HUD_LAUNCH_GRACE_SECONDS
            )
            if not hud_processes and (hud_process_seen or launch_grace_expired):
                raise HarnessError(
                    "HUD launcher exited before client became ready; HUD log:\n"
                    f"{self.hud_log_text()}"
                )
            if time.monotonic() >= self.deadline:
                raise HarnessError("timed out resolving two fixtures and one HUD")
            time.sleep(0.1)
        assert self.output_id is not None
        for client in clients:
            if client.get("monitor") != self.output_id or client.get("workspace", {}).get("name") != self.workspace:
                raise HarnessError(f"token-owned client mapped outside detached target: {client.get('address')}")
            pid = client["pid"]
            if not self.token_in_environ(pid):
                raise HarnessError(f"lost token ownership proof for pid {pid}")
            self.owned_pids.add(pid)
        addresses = [client.get("address") for client in clients]
        if len(addresses) != len(set(addresses)) or any(not address for address in addresses):
            raise HarnessError("token-owned clients did not resolve to unique addresses")
        self.check("clients-resolved", {"pids": sorted(self.owned_pids), "addresses": addresses})
        processes = self.token_processes()
        if not self.owned_pids.issubset(processes):
            raise HarnessError("client PID lost token process ownership")
        self.owned_pids.update(processes)
        self.check("token-processes-resolved", sorted(processes))
        return clients, hud[0]

    def wait_for_hud_placement(self, hud: dict[str, Any]) -> dict[str, Any]:
        address = hud.get("address")
        if not isinstance(address, str) or not address:
            raise HarnessError("HUD has no exact address for placement proof")
        stable = 0
        last_geometry: dict[str, Any] | None = None
        nudge_at = 0.0
        while time.monotonic() < self.deadline:
            monitors = self.query("monitors")
            clients = self.query("clients")
            monitor = next(
                (item for item in monitors if item.get("name") == self.output),
                None,
            )
            current = next(
                (item for item in clients if item.get("address") == address),
                None,
            )
            if monitor is None or current is None:
                stable = 0
                time.sleep(0.1)
                continue
            scale = float(monitor.get("scale") or 0)
            at = current.get("at")
            size = current.get("size")
            valid_numbers = (
                scale > 0
                and isinstance(at, list)
                and len(at) == 2
                and isinstance(size, list)
                and len(size) == 2
                and all(isinstance(value, (int, float)) for value in [*at, *size])
            )
            if not valid_numbers:
                stable = 0
                time.sleep(0.1)
                continue
            logical_width = round(float(monitor.get("width") or 0) / scale)
            logical_height = round(float(monitor.get("height") or 0) / scale)
            expected = [
                int(monitor.get("x") or 0) + (logical_width - int(size[0])) // 2,
                int(monitor.get("y") or 0) + logical_height - int(size[1]) - 16,
            ]
            geometry = {
                "address": address,
                "pid": current.get("pid"),
                "monitor": self.output,
                "monitor_id": monitor.get("id"),
                "monitor_origin": [monitor.get("x"), monitor.get("y")],
                "monitor_physical_size": [monitor.get("width"), monitor.get("height")],
                "monitor_scale": scale,
                "monitor_logical_size": [logical_width, logical_height],
                "hud_at": at,
                "hud_size": size,
                "expected_at": expected,
                "bottom_margin": 16,
                "floating": current.get("floating"),
                "pinned": current.get("pinned"),
            }
            placed = (
                current.get("monitor") == self.output_id
                and current.get("workspace", {}).get("name") == self.workspace
                and current.get("floating") is True
                and current.get("pinned") is not True
                and at == expected
                and int(size[0]) > 0
                and int(size[1]) > 0
                and int(size[0]) <= logical_width
            )
            if placed and geometry == last_geometry:
                stable += 1
            elif placed:
                stable = 1
            else:
                stable = 0
                now = time.monotonic()
                if now >= nudge_at:
                    nudge_at = now + 1.0
                    try:
                        from omp_hud.hyprland import promote_hud_overlay

                        promote_env = dict(os.environ)
                        promote_env["OMP_HUD_E2E_NO_PIN"] = "1"
                        promote_hud_overlay(
                            width=1188,
                            height=70,
                            attempts=4,
                            delay=0.05,
                            env=promote_env,
                        )
                    except Exception as error:
                        self.evidence.setdefault("placement_nudges", []).append(
                            str(error)
                        )
            last_geometry = geometry
            if stable >= 3:
                self.check("hud-placement-proved", geometry)
                return geometry
            time.sleep(0.1)
        raise HarnessError(
            "HUD did not reach stable floating/unpinned bottom-centered geometry: "
            f"{last_geometry}"
        )
    def capture(self) -> None:
        if not self.args.dry_run:
            self.args.screenshot.parent.mkdir(parents=True, exist_ok=True)
        self.runner.run(["grim", "-o", self.output, str(self.args.screenshot)], timeout=self.remaining())
        if not self.args.dry_run and (not self.args.screenshot.is_file() or self.args.screenshot.stat().st_size == 0):
            raise HarnessError("grim did not produce a non-empty screenshot")
        self.check("screenshot-captured", str(self.args.screenshot))

    def inspect_atspi(self, hud_pid: int, hud_address: str | None = None) -> None:
        if hud_address is not None:
            matches = [
                client for client in self.token_clients()
                if client.get("address") == hud_address and client.get("pid") == hud_pid
            ]
            if len(matches) != 1:
                raise HarnessError("HUD address/PID ownership was not unique before input")
        if self.args.dry_run:
            self.check(
                "atspi-pid-scoped",
                {
                    "pid": hud_pid,
                    "address": hud_address,
                    "window_count": 1,
                    "choices": 2,
                    "ready_control": "Prompt for selected desktop target",
                    "prompt_sensitive": True,
                    "microphone_enabled": True,
                    "keyboard": {"before": "A", "down": "B", "restored": "A"},
                    "scroll": {
                        "before": "A",
                        "down": "B",
                        "restored": "A",
                        "point": [1, 1],
                    },
                },
            )
            return
        probe = Path(__file__).resolve().with_name("handsfree_atspi_probe.py")
        if not probe.is_file():
            raise HarnessError(f"AT-SPI probe missing: {probe}")
        # Unit tests inspect the probe source for PID scoping.
        probe_source = probe.read_text(encoding="utf-8")
        if "process_id(n) == pid" not in probe_source:
            raise HarnessError("AT-SPI probe is not PID-scoped")
        original_address = self.original.get("activewindow")
        if not isinstance(original_address, str):
            original_address = None
        # Fixed interaction budget so slow fixture/map cannot starve AT-SPI.
        budget = 30.0
        result = None
        try:
            result = self.runner.run(
                [
                    "python3",
                    str(probe),
                    str(hud_pid),
                    self.token,
                    str(budget),
                    hud_address or "",
                ],
                timeout=budget + 5.0,
            )
        finally:
            if original_address:
                self.runner.run(
                    [
                        "hyprctl",
                        "dispatch",
                        f'hl.dsp.focus({{ window = "address:{original_address}" }})',
                    ],
                    timeout=self.remaining(floor=1.0),
                    check=False,
                )
        if result is None:
            raise HarnessError("AT-SPI probe did not return a result")
        detail = json.loads(result.stdout)
        detail["address"] = hud_address
        self.check("atspi-pid-scoped", detail)


    def check_log(self) -> None:
        if not self.args.dry_run and not self.log_path.is_file():
            raise HarnessError("mandatory HUD log is missing")
        text = "" if self.args.dry_run else self.log_path.read_text(errors="replace")
        diagnostic_terms = (
            "gtk-error", "gtk-critical", "gtk-warning",
            "gdk-error", "gdk-critical", "gdk-warning",
            "glib-error", "glib-critical", "glib-warning",
            "overlay-error", "overlay-critical", "overlay warning",
        )
        # AT-SPI opens the target combo without a pointer gesture; GTK complains.
        benign = (
            "no trigger event for menu popup",
        )
        bad = []
        for line in text.splitlines():
            folded = line.casefold()
            if any(noise in folded for noise in benign):
                continue
            if (
                any(term in folded for term in diagnostic_terms)
                or ("overlay" in folded and any(
                    level in folded for level in ("error", "critical", "warning")
                ))
            ):
                bad.append(line)
        if bad:
            raise HarnessError(f"GTK/GDK/GLib or overlay diagnostics in HUD log: {bad[:5]}")
        self.evidence["hud_log"] = {
            "path": str(self.log_path),
            "bytes": 0 if self.args.dry_run else self.log_path.stat().st_size,
        }
        self.check("gtk-log-clean")

    def headless_monitor(self) -> dict[str, Any]:
        monitors = self.query("monitors")
        monitor = next(
            (item for item in monitors if item.get("name") == self.output),
            None,
        )
        if not isinstance(monitor, dict):
            raise HarnessError(f"headless output missing during workflow: {self.output}")
        return monitor

    def assert_client_gated(self, client: dict[str, Any], *, label: str) -> None:
        if client.get("monitor") != self.output_id:
            raise HarnessError(
                f"{label} mapped outside headless monitor: {client.get('address')}"
            )
        workspace = client.get("workspace") or {}
        if workspace.get("name") != self.workspace:
            raise HarnessError(
                f"{label} mapped outside e2e workspace: {client.get('address')}"
            )
        pid = client.get("pid")
        if not isinstance(pid, int) or not self.token_in_environ(pid):
            raise HarnessError(f"{label} lost token ownership")
        self.owned_pids.add(pid)

    def wait_token_client(
        self,
        *,
        class_prefix: str | None = None,
        title_substr: str | None = None,
        exclude_addresses: set[str] | None = None,
    ) -> dict[str, Any]:
        excluded = exclude_addresses or set()
        while time.monotonic() < self.deadline:
            for client in self.token_clients():
                address = client.get("address")
                if not isinstance(address, str) or address in excluded:
                    continue
                class_name = str(client.get("class") or "")
                title = str(client.get("title") or "")
                if class_prefix and not class_name.startswith(class_prefix):
                    continue
                if title_substr and title_substr not in title:
                    continue
                self.assert_client_gated(client, label=title or class_name or address)
                return client
            time.sleep(0.1)
        raise HarnessError(
            f"timed out waiting for gated client class={class_prefix!r} title~{title_substr!r}"
        )

    def gate_token_clients(self) -> list[dict[str, Any]]:
        """Prove every token-owned client stays on the detached headless target."""
        clients = self.token_clients()
        leaked = [
            {
                "address": client.get("address"),
                "title": client.get("title"),
                "monitor": client.get("monitor"),
                "workspace": (client.get("workspace") or {}).get("name"),
            }
            for client in clients
            if client.get("monitor") != self.output_id
            or (client.get("workspace") or {}).get("name") != self.workspace
        ]
        if leaked:
            raise HarnessError(f"token-owned clients escaped headless gate: {leaked}")
        for client in clients:
            pid = client.get("pid")
            if isinstance(pid, int):
                self.owned_pids.add(pid)
        self.check(
            "headless-gate",
            {
                "output": self.output,
                "workspace": self.workspace,
                "client_count": len(clients),
                "addresses": [client.get("address") for client in clients],
            },
        )
        return clients

    def dispatch_window(self, expression: str) -> None:
        result = self.runner.run(
            ["hyprctl", "dispatch", expression],
            timeout=self.remaining(floor=2.0),
            check=False,
        )
        if self.args.dry_run:
            return
        reply = (result.stdout or result.stderr or "").strip()
        if result.returncode != 0 and reply not in {"", "ok"}:
            raise HarnessError(f"window dispatch failed: {expression}: {reply}")

    def dispatch_legacy(self, dispatcher: str, argument: str) -> str:
        """Hyprland 0.56 parses single-string dispatch as Lua; pass argv parts."""
        result = self.runner.run(
            ["hyprctl", "dispatch", dispatcher, argument],
            timeout=self.remaining(floor=2.0),
            check=False,
        )
        if self.args.dry_run:
            return "ok"
        return (result.stdout or result.stderr or "").strip()

    def focus_address(self, address: str) -> None:
        self.dispatch_window(f'hl.dsp.focus({{ window = "address:{address}" }})')

    def set_floating(self, address: str, floating: bool) -> None:
        client = next(
            (
                item
                for item in self.query("clients")
                if item.get("address") == address
            ),
            None,
        )
        if client is not None and bool(client.get("floating")) is floating:
            return
        # Best-effort: 0.56 Lua rejects `setfloating address:…` as one token.
        # Geometry move/resize still applies on tiled windows for side-by-side proof.
        selector = f"address:{address}"
        for dispatcher in ("setfloating", "togglefloating"):
            reply = self.dispatch_legacy(dispatcher, selector)
            if reply in {"", "ok"}:
                break
        client = next(
            (
                item
                for item in self.query("clients")
                if item.get("address") == address
            ),
            None,
        )
        if client is not None and bool(client.get("floating")) is floating:
            return
        self.evidence.setdefault("workflow_notes", []).append(
            {
                "action": "set_floating",
                "address": address,
                "wanted": floating,
                "actual": None if client is None else client.get("floating"),
                "note": "continuing with move/resize without floating guarantee",
            }
        )

    def move_resize(
        self, address: str, x: int, y: int, width: int, height: int
    ) -> None:
        selector = f"address:{address}"
        self.dispatch_window(
            f'hl.dsp.window.resize({{ x = {width}, y = {height}, window = "{selector}" }})'
        )
        self.dispatch_window(
            f'hl.dsp.window.move({{ x = {x}, y = {y}, window = "{selector}" }})'
        )

    def tile_side_by_side(
        self, left_address: str, right_address: str
    ) -> dict[str, Any]:
        monitor = self.headless_monitor()
        scale = float(monitor.get("scale") or 1) or 1.0
        origin_x = int(monitor.get("x") or 0)
        origin_y = int(monitor.get("y") or 0)
        logical_w = round(float(monitor.get("width") or 0) / scale)
        logical_h = round(float(monitor.get("height") or 0) / scale)
        if logical_w < 200 or logical_h < 200:
            raise HarnessError("headless monitor too small to tile")
        gap = 8
        top = origin_y + 40
        height = max(120, logical_h - 120)
        left_w = (logical_w - gap) // 2
        right_w = logical_w - gap - left_w
        left_x = origin_x
        right_x = origin_x + left_w + gap
        for address, x, width in (
            (left_address, left_x, left_w),
            (right_address, right_x, right_w),
        ):
            self.set_floating(address, True)
            self.move_resize(address, x, top, width, height)
        clients = {
            client.get("address"): client for client in self.query("clients")
        }
        left = clients.get(left_address)
        right = clients.get(right_address)
        if left is None or right is None:
            raise HarnessError("tiled clients disappeared")
        self.assert_client_gated(left, label="left tile")
        self.assert_client_gated(right, label="right tile")
        detail = {
            "left": {
                "address": left_address,
                "at": left.get("at"),
                "size": left.get("size"),
            },
            "right": {
                "address": right_address,
                "at": right.get("at"),
                "size": right.get("size"),
            },
            "monitor": self.output,
            "logical_size": [logical_w, logical_h],
        }
        left_at = left.get("at") or [0, 0]
        right_at = right.get("at") or [0, 0]
        if not (
            isinstance(left_at, list)
            and isinstance(right_at, list)
            and len(left_at) == 2
            and len(right_at) == 2
            and int(right_at[0]) > int(left_at[0])
        ):
            raise HarnessError(f"side-by-side geometry not ordered: {detail}")
        self.check("workflow-tiled", detail)
        return detail

    def run_developer_workflow(self) -> None:
        """Deterministic multi-app path on the gated headless output."""
        if self.args.dry_run:
            self.check(
                "workflow-planned",
                ["kitty-echo", "firefox-google", "tile", "headless-gate"],
            )
            return

        echo_path = Path(tempfile.gettempdir()) / f"{self.token}-kitty-echo.txt"
        if echo_path.exists():
            echo_path.unlink()

        known = {
            address
            for address in (
                client.get("address") for client in self.token_clients()
            )
            if isinstance(address, str)
        }

        kitty_class = f"{self.token}-workflow-kitty"
        kitty_title = f"{self.token} workflow kitty"
        # Force a fresh instance so user kitty single-instance mode cannot absorb the window.
        self.dispatch_exec(
            [
                "kitty",
                "--single-instance=no",
                "--instance-group",
                self.token,
                "--class",
                kitty_class,
                "--title",
                kitty_title,
                "sh",
                "-c",
                f"printf 'hi\\n' > {shlex.quote(str(echo_path))} && exec sleep 86400",
            ]
        )
        # Echo file is the command proof; then attach the gated window.
        while time.monotonic() < self.deadline:
            if echo_path.is_file() and echo_path.read_text(encoding="utf-8") == "hi\n":
                break
            time.sleep(0.05)
        else:
            raise HarnessError(f"kitty did not write echo proof at {echo_path}")
        kitty = None
        while time.monotonic() < self.deadline:
            for client in self.token_clients():
                address = client.get("address")
                if not isinstance(address, str) or address in known:
                    continue
                title = str(client.get("title") or "")
                class_name = str(client.get("class") or "")
                if (
                    "workflow kitty" in title
                    or class_name == kitty_class
                    or class_name.startswith(f"{self.token}-")
                ):
                    self.assert_client_gated(client, label=title or class_name or address)
                    kitty = client
                    break
            if kitty is not None:
                break
            time.sleep(0.1)
        if kitty is None:
            raise HarnessError("echo proof written but gated kitty window never appeared")
        known.add(str(kitty.get("address")))
        self.check(
            "workflow-kitty-echo",
            {
                "address": kitty.get("address"),
                "class": kitty.get("class"),
                "title": kitty.get("title"),
                "path": str(echo_path),
                "content": "hi\n",
            },
        )

        firefox_class_prefix = f"{self.token}-workflow-firefox"
        firefox_profile = Path(tempfile.gettempdir()) / f"{self.token}-firefox-profile"
        firefox_profile.mkdir(parents=True, exist_ok=True)
        (firefox_profile / "user.js").write_text(
            "\n".join(
                [
                    'user_pref("browser.shell.checkDefaultBrowser", false);',
                    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
                    'user_pref("startup.homepage_welcome_url", "");',
                    'user_pref("startup.homepage_welcome_url.additional", "");',
                    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
                    'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
                    'user_pref("browser.aboutwelcome.enabled", false);',
                ]
            )
            + "\n",
            encoding="utf-8",
        )
        # Existing user Firefox absorbs windows; force dedicated instance + profile so
        # the window PID inherits OMP_HANDSFREE_E2E_TOKEN and stays headless-gated.
        # dispatch_exec already wraps with env TOKEN=...; add MOZ_NO_REMOTE via assignment.
        assignment = (
            f"OMP_HANDSFREE_E2E_TOKEN={shlex.quote(self.token)} "
            f"OMP_HUD_E2E_NO_PIN=1 "
            f"OMP_E2E_MONITOR={shlex.quote(self.output)} "
            f"OMP_E2E_WORKSPACE={shlex.quote(self.workspace)} "
            f"MOZ_NO_REMOTE=1"
        )
        shell_command = (
            f"env {assignment} "
            + shlex.join(
                [
                    "firefox",
                    "--new-instance",
                    "--no-remote",
                    "--profile",
                    str(firefox_profile),
                    "https://www.google.com/",
                    "--class",
                    firefox_class_prefix,
                ]
            )
        )
        expression = (
            f"hl.dsp.exec_cmd({json.dumps(shell_command)}, "
            f'{{ workspace = "name:{self.workspace}", '
            f'monitor = "{self.output}", no_initial_focus = true }})'
        )
        result = self.runner.run(
            ["hyprctl", "dispatch", expression], timeout=self.remaining()
        )
        if not self.args.dry_run and result.stdout.strip() not in {"", "ok"}:
            response = result.stdout.strip() or result.stderr.strip() or "<empty response>"
            raise HarnessError(f"Hyprland dispatcher rejected Firefox launch: {response}")
        firefox = None
        while time.monotonic() < self.deadline:
            for client in self.token_clients():
                address = client.get("address")
                if not isinstance(address, str) or address in known:
                    continue
                title = str(client.get("title") or "").casefold()
                class_name = str(client.get("class") or "").casefold()
                if (
                    "firefox" in class_name
                    or class_name.startswith(firefox_class_prefix.casefold())
                    or "google" in title
                    or "mozilla" in title
                    or "firefox" in title
                ):
                    self.assert_client_gated(client, label="firefox workflow")
                    firefox = client
                    break
            if firefox is not None:
                break
            time.sleep(0.15)
        if firefox is None:
            raise HarnessError("timed out waiting for gated Firefox window")
        known.add(str(firefox.get("address")))
        self.check(
            "workflow-firefox-google",
            {
                "address": firefox.get("address"),
                "title": firefox.get("title"),
                "class": firefox.get("class"),
                "profile": str(firefox_profile),
            },
        )

        self.tile_side_by_side(str(kitty.get("address")), str(firefox.get("address")))
        self.gate_token_clients()
        self.evidence["workflow"] = {
            "kitty": kitty.get("address"),
            "firefox": firefox.get("address"),
            "echo_path": str(echo_path),
            "firefox_profile": str(firefox_profile),
        }

    def kill_verified(self, sig: int) -> None:
        for pid in sorted(self.owned_pids):
            if not self.token_in_environ(pid):
                self.evidence["cleanup"].append({"action": "signal", "pid": pid, "signal": sig, "skipped": "ownership-not-proven"})
                continue
            try:
                os.kill(pid, sig)
                self.evidence["cleanup"].append({"action": "signal", "pid": pid, "signal": sig, "passed": True})
            except ProcessLookupError:
                self.evidence["cleanup"].append({"action": "signal", "pid": pid, "signal": sig, "passed": True, "detail": "already-exited"})

    def wait_for_stable_zero(
        self, seconds: float, consecutive: int = 3
    ) -> tuple[bool, list[dict[str, Any]]]:
        if self.cleanup_deadline is None:
            raise HarnessError("cleanup deadline was not initialized")
        end = min(self.cleanup_deadline, time.monotonic() + seconds)
        stable = 0
        samples: list[dict[str, Any]] = []
        while time.monotonic() < end:
            clients = self.token_clients(deadline=self.cleanup_deadline)
            processes = self.token_processes()
            sample = {
                "client_addresses": [client.get("address") for client in clients],
                "processes": sorted(processes),
            }
            samples.append(sample)
            stable = stable + 1 if not clients and not processes else 0
            if stable >= consecutive:
                return True, samples
            time.sleep(0.1)
        return False, samples

    def wait_zero_clients(self, seconds: float) -> bool:
        passed, _ = self.wait_for_stable_zero(seconds)
        return passed

    def cleanup(self) -> None:
        if self.args.dry_run:
            self.evidence["cleanup"].append({"action": "dry-run", "passed": True})
            return
        self.cleanup_deadline = time.monotonic() + 15.0
        cleanup_error: str | None = None
        try:
            self.owned_pids.update(self.token_processes())
            self.kill_verified(signal.SIGTERM)
            zero, samples = self.wait_for_stable_zero(
                min(3.0, max(0.4, self.cleanup_remaining()))
            )
            if not zero:
                self.owned_pids.update(self.token_processes())
                self.kill_verified(signal.SIGKILL)
                zero, samples = self.wait_for_stable_zero(
                    min(3.0, max(0.4, self.cleanup_remaining()))
                )
            self.evidence["cleanup"].append({
                "action": "stable-zero-proof",
                "passed": zero,
                "samples": samples,
            })
            if not zero:
                raise HarnessError(
                    "token-owned clients or processes remain; output deliberately left intact"
                )
            if self.output_created:
                self.runner.run(
                    ["hyprctl", "output", "remove", self.output],
                    timeout=max(0.1, self.cleanup_remaining()),
                )
                monitors = self.query("monitors", deadline=self.cleanup_deadline)
                if any(monitor.get("name") == self.output for monitor in monitors):
                    raise HarnessError(
                        "detached output still exists after removal; retained created state"
                    )
                self.evidence["cleanup"].append({
                    "action": "monitor-absence-proof", "passed": True,
                    "output": self.output,
                })
                self.output_created = False
                self.evidence["cleanup"].append({"action": "remove-output", "passed": True})
            original_address = self.original.get("activewindow")
            if isinstance(original_address, str) and original_address:
                self.runner.run(
                    [
                        "hyprctl",
                        "dispatch",
                        f'hl.dsp.focus({{ window = "address:{original_address}" }})',
                    ],
                    timeout=max(1.0, self.cleanup_remaining()),
                    check=False,
                )
                time.sleep(0.1)
            try:
                current_clients = self.query(
                    "clients", deadline=self.cleanup_deadline
                )
                current_active_window = self.query(
                    "activewindow", deadline=self.cleanup_deadline
                )
                current_active_workspace = self.query(
                    "activeworkspace", deadline=self.cleanup_deadline
                )
            except Exception as error:
                raise HarnessError(
                    "could not verify pre-existing client state"
                ) from error
            if (
                not isinstance(current_clients, list)
                or (
                    isinstance(current_clients, list)
                    and any(not isinstance(client, dict) for client in current_clients)
                )
                or not isinstance(current_active_window, dict)
                or not isinstance(current_active_workspace, dict)
            ):
                raise HarnessError("could not verify pre-existing client state")
            current_by_address = {
                client.get("address"): self.window_snapshot(client)
                for client in current_clients
                if client.get("address") in self.original.get("clients", {})
            }
            original_by_address = self.original.get("clients", {})
            if current_by_address.keys() != original_by_address.keys():
                raise HarnessError("pre-existing client disappeared")
            for address, original_snapshot in original_by_address.items():
                current_snapshot = current_by_address[address]
                if original_snapshot.get("pinned") is True:
                    original_snapshot = {
                        key: value
                        for key, value in original_snapshot.items()
                        if key != "workspace"
                    }
                    current_snapshot = {
                        key: value
                        for key, value in current_snapshot.items()
                        if key != "workspace"
                    }
                if current_snapshot != original_snapshot:
                    raise HarnessError(
                        "pre-existing client workspace, monitor, geometry, floating, or pinned state changed"
                    )
            active_window_address = current_active_window.get("address")
            active_workspace = self.workspace_identity(current_active_workspace)
            if (
                active_window_address != self.original.get("activewindow")
                or active_workspace != self.original.get("activeworkspace")
            ):
                raise HarnessError(
                    "original focus or active workspace changed"
                )
            self.evidence["cleanup"].append({
                "action": "original-state-restored", "passed": True,
                "client_addresses": sorted(current_by_address),
            })
        except Exception as error:
            cleanup_error = str(error)
            self.evidence["cleanup"].append(
                {"action": "cleanup", "passed": False, "error": cleanup_error}
            )
        if cleanup_error:
            raise HarnessError(cleanup_error)

    def run(self) -> dict[str, Any]:
        failure: BaseException | None = None
        try:
            self.snapshot_original()
            self.create_output()
            self.launch()
            if not self.args.dry_run:
                _, hud = self.wait_for_clients()
                geometry = self.wait_for_hud_placement(hud)
                self.evidence["screenshot_geometry"] = geometry
                self.capture()
                self.inspect_atspi(hud["pid"], hud["address"])
                self.check_log()
                if getattr(self.args, "workflow", True):
                    self.run_developer_workflow()
            elif getattr(self.args, "workflow", True):
                self.run_developer_workflow()
            self.evidence["status"] = "passed"
        except BaseException as error:
            failure = error
            self.evidence["status"] = "failed"
            self.evidence["error"] = str(error)
        finally:
            try:
                self.cleanup()
            except BaseException as error:
                self.evidence["status"] = "failed"
                self.evidence["cleanup_error"] = str(error)
                if failure is None:
                    failure = error
            self.write_evidence()
        if failure is not None:
            raise failure
        return self.evidence

    def write_evidence(self) -> None:
        self.args.evidence.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.args.evidence.with_suffix(self.args.evidence.suffix + ".tmp")
        temporary.write_text(json.dumps(self.evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(self.args.evidence)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print and record the plan without side effects")
    parser.add_argument("--timeout", type=float, default=45.0, help="whole-run deadline in seconds")
    parser.add_argument("--evidence", type=Path, default=Path("handsfree-e2e-evidence.json"))
    parser.add_argument("--screenshot", type=Path, default=Path("handsfree-e2e.png"))
    parser.add_argument(
        "--workflow",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="run developer multi-app workflow after isolation smoke (default: on)",
    )
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    harness = HandsfreeHarness(args)
    previous: dict[int, Any] = {}

    def interrupted(signum: int, _frame: Any) -> None:
        harness.interrupted = signum
        raise KeyboardInterrupt(f"received signal {signum}")

    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        previous[signum] = signal.signal(signum, interrupted)
    try:
        evidence = harness.run()
        if args.dry_run:
            print(json.dumps(evidence, indent=2, sort_keys=True))
        return 0
    except BaseException as error:
        print(f"handsfree E2E failed: {error}", file=sys.stderr)
        return 1
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    raise SystemExit(main())
