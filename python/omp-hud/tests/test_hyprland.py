from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import unittest

from omp_hud.hyprland import (
    ContextMonitor,
    HyprctlError,
    HyprlandContext,
    HyprlandWindow,
    promote_hud_overlay,
    read_context,
    read_windows,
)


class HyprlandContextTests(unittest.TestCase):
    def test_reads_active_workspace_and_window_without_shell(self) -> None:
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            stdout = (
                '{"id": 7, "name": "special:work"}'
                if command[-1] == "activeworkspace"
                else '{"class": "kitty", "title": "OMP"}'
            )
            return subprocess.CompletedProcess(command, 0, stdout=stdout, stderr="")

        context = read_context(runner)

        self.assertEqual("special:work", context.workspace)
        self.assertEqual("kitty", context.app_class)
        self.assertEqual("OMP", context.title)
        self.assertEqual("Workspace special:work · kitty", context.label)
        self.assertEqual(
            [
                ["hyprctl", "-j", "activeworkspace"],
                ["hyprctl", "-j", "activewindow"],
            ],
            commands,
        )

    def test_reads_selectable_windows_with_stable_hyprland_identity(self) -> None:
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            return subprocess.CompletedProcess(
                command,
                0,
                stdout=(
                    '[{"address":"0xabc","mapped":true,"class":"firefox",'
                    '"title":"PER-606","pid":41,"workspace":{"id":2,"name":"work"}},'
                    '{"address":"0xhidden","mapped":false,"class":"hidden"}]'
                ),
                stderr="",
            )

        windows = read_windows(runner)
        self.assertEqual(
            (
                HyprlandWindow(
                    address="0xabc",
                    workspace="work",
                    app_class="firefox",
                    title="PER-606",
                    pid=41,
                ),
            ),
            windows,
        )
        self.assertEqual("0xabc", windows[0].key)
        self.assertEqual(
            HyprlandContext("work", "firefox", "PER-606", "0xabc"),
            windows[0].as_context(),
        )
        self.assertEqual([["hyprctl", "-j", "clients"]], commands)

    def test_surfaces_invalid_hyprctl_json(self) -> None:
        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            return subprocess.CompletedProcess(command, 0, stdout="not-json", stderr="")

        with self.assertRaisesRegex(HyprctlError, "activeworkspace failed"):
            read_context(runner)

    def test_monitor_emits_only_context_changes(self) -> None:
        observed: list[HyprlandContext] = []
        ready = threading.Event()
        contexts = iter(
            [
                HyprlandContext("1", "kitty", "OMP"),
                HyprlandContext("1", "kitty", "OMP"),
                HyprlandContext("2", "firefox", "Issues"),
            ]
        )
        last = HyprlandContext("2", "firefox", "Issues")

        def reader() -> HyprlandContext:
            try:
                return next(contexts)
            except StopIteration:
                return last

        def on_context(context: HyprlandContext) -> None:
            observed.append(context)
            if len(observed) == 2:
                ready.set()

        monitor = ContextMonitor(
            on_context,
            self.fail,
            interval=0.01,
            reader=reader,
            socket_path=lambda: None,
        )
        monitor.start()
        self.assertTrue(ready.wait(1.0))
        monitor.stop()

        self.assertEqual(
            [
                HyprlandContext("1", "kitty", "OMP"),
                HyprlandContext("2", "firefox", "Issues"),
            ],
            observed,
        )

    def test_monitor_restores_unchanged_context_after_error(self) -> None:
        context = HyprlandContext("1", "kitty", "OMP")
        observed: list[HyprlandContext] = []
        errors: list[str] = []
        restored = threading.Event()
        readings: list[HyprlandContext | HyprctlError] = [
            context,
            HyprctlError("temporary failure"),
            context,
        ]

        def reader() -> HyprlandContext:
            if readings:
                reading = readings.pop(0)
                if isinstance(reading, HyprctlError):
                    raise reading
                return reading
            return context

        def on_context(value: HyprlandContext) -> None:
            observed.append(value)
            if len(observed) == 2:
                restored.set()

        monitor = ContextMonitor(
            on_context,
            errors.append,
            interval=0.01,
            reader=reader,
            socket_path=lambda: None,
        )
        monitor.start()
        self.assertTrue(restored.wait(1.0))
        monitor.stop()

        self.assertEqual([context, context], observed)
        self.assertEqual(["temporary failure"], errors)

    def test_event_socket_refreshes_only_for_relevant_events(self) -> None:
        monitor_socket, compositor_socket = socket.socketpair()
        context_calls = 0
        window_calls = 0
        initial = threading.Event()
        context_changed = threading.Event()
        windows_changed = threading.Event()

        def context_reader() -> HyprlandContext:
            nonlocal context_calls
            context_calls += 1
            if context_calls == 1:
                initial.set()
            return HyprlandContext(str(context_calls), "kitty", "OMP")

        def window_reader() -> tuple[HyprlandWindow, ...]:
            nonlocal window_calls
            window_calls += 1
            return (
                HyprlandWindow(
                    f"0x{window_calls}",
                    "1",
                    "kitty",
                    "OMP",
                ),
            )

        monitor = ContextMonitor(
            lambda _context: context_changed.set() if context_calls > 1 else None,
            self.fail,
            interval=5.0,
            reader=context_reader,
            on_windows=lambda _windows: windows_changed.set()
            if window_calls > 1
            else None,
            window_reader=window_reader,
            socket_path=lambda: "event.sock",
            socket_connector=lambda _path: monitor_socket,
        )
        monitor.start()
        self.assertTrue(initial.wait(1.0))
        time.sleep(0.03)
        self.assertEqual((1, 1), (context_calls, window_calls))

        compositor_socket.sendall(b"submap>>resize\nworkspacev2>>2,work\n")
        self.assertTrue(context_changed.wait(1.0))
        self.assertEqual(1, window_calls)

        compositor_socket.sendall(b"openwindow>>0xabc,2,kitty,OMP\n")
        self.assertTrue(windows_changed.wait(1.0))
        self.assertEqual(2, context_calls)
        monitor.stop()
        compositor_socket.close()

    def test_promotes_and_verifies_hud_client(self) -> None:
        floating = False
        pinned = False
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal floating, pinned
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "abc",
                        "mapped": True,
                        "namespace": "omp-hud",
                        "title": "OMP HUD",
                        "floating": floating,
                        "pinned": pinned,
                    }
                ]
                return subprocess.CompletedProcess(
                    command,
                    0,
                    stdout=json.dumps(payload),
                    stderr="",
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.float" in dispatched:
                floating = True
            elif "window.pin" in dispatched:
                pinned = True
            elif dispatched == "setfloating":
                floating = True
            elif dispatched == "pin":
                pinned = True
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        self.assertEqual(
            [
                ["hyprctl", "-j", "clients"],
                ["hyprctl", "dispatch", 'hl.dsp.window.float({ action = "enable", window = "address:0xabc" })'],
                ["hyprctl", "dispatch", 'hl.dsp.window.pin({ action = "enable", window = "address:0xabc" })'],
                ["hyprctl", "-j", "clients"],
            ],
            commands,
        )
    def test_positions_hud_at_bottom_center_of_focused_scaled_monitor(self) -> None:
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "0xabc",
                        "mapped": True,
                        "class": "omp-hud",
                        "title": "OMP HUD",
                        "floating": True,
                        "pinned": True,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [
                    {
                        "focused": True,
                        "x": 1920,
                        "y": 0,
                        "width": 3840,
                        "height": 2160,
                        "scale": 2,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            width=1188,
            height=820,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        self.assertIn(
            [
                "hyprctl",
                "dispatch",
                'hl.dsp.window.move({ x = 2286, y = 244, window = "address:0xabc" })',
            ],
            commands,
        )


    def test_promote_reports_missing_hyprland(self) -> None:
        with self.assertRaisesRegex(HyprctlError, "Hyprland is unavailable"):
            promote_hud_overlay(attempts=1, env={})


if __name__ == "__main__":
    unittest.main()
