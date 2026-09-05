from __future__ import annotations

import json
import socket
import subprocess
import threading
import time
import unittest

from omp_hud.hyprland import (
    _calculate_hud_position,
    CarouselMonitor,
    ContextMonitor,
    HyprctlError,
    HyprlandContext,
    HyprlandWindow,
    auto_stage_enabled,
    compute_carousel_slots,
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
                        "title": "OMP Handsfree Mode",
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

        # Default MVP: float only — pin is opt-in via OMP_HUD_PIN=1.
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
                ["hyprctl", "-j", "clients"],
            ],
            commands,
        )
        self.assertTrue(floating)
        self.assertFalse(pinned)

    def test_promotes_with_pin_when_requested(self) -> None:
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
                        "title": "OMP Handsfree Mode",
                        "floating": floating,
                        "pinned": pinned,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.float" in dispatched or dispatched == "setfloating":
                floating = True
            elif "window.pin" in dispatched or dispatched == "pin":
                pinned = True
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            env={
                "HYPRLAND_INSTANCE_SIGNATURE": "test",
                "OMP_HUD_PIN": "1",
            },
        )

        self.assertTrue(floating)
        self.assertTrue(pinned)
        self.assertTrue(
            any("window.pin" in " ".join(c) or c[-1:] == ["pin"] or "pin" in c for c in commands)
        )

    def test_e2e_no_pin_skips_pin_and_requires_unpinned(self) -> None:
        floating = False
        pinned = True
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal floating, pinned
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "abc",
                        "mapped": True,
                        "title": "OMP Handsfree Mode",
                        "floating": floating,
                        "pinned": pinned,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.float" in dispatched or dispatched == "setfloating":
                floating = True
            elif "action = \"disable\"" in dispatched or (
                dispatched == "pin" and pinned
            ):
                pinned = False
            elif "window.pin" in dispatched or dispatched == "pin":
                pinned = True
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            env={
                "HYPRLAND_INSTANCE_SIGNATURE": "test",
                "OMP_HUD_E2E_NO_PIN": "1",
            },
        )

        self.assertEqual(
            [
                ["hyprctl", "-j", "clients"],
                ["hyprctl", "dispatch", 'hl.dsp.window.float({ action = "enable", window = "address:0xabc" })'],
                ["hyprctl", "dispatch", 'hl.dsp.window.pin({ action = "disable", window = "address:0xabc" })'],
                ["hyprctl", "-j", "clients"],
            ],
            commands,
        )
        self.assertTrue(floating)
        self.assertFalse(pinned)

    def test_positions_hud_inside_its_own_scaled_nonfocused_monitor(self) -> None:
        commands: list[list[str]] = []
        hud_position = [0, 0]

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "0xabc",
                        "mapped": True,
                        "class": "omp-hud",
                        "title": "OMP Handsfree Mode",
                        "floating": True,
                        "pinned": True,
                        "monitor": 7,
                        "size": [900, 70],
                        "at": hud_position,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [
                    {
                        "id": 3,
                        "focused": True,
                        "x": 0,
                        "y": 0,
                        "width": 1920,
                        "height": 1080,
                        "scale": 1,
                    },
                    {
                        "id": 7,
                        "focused": False,
                        "x": 1920,
                        "y": 120,
                        "width": 1920,
                        "height": 1080,
                        "scale": 2,
                    },
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.move" in dispatched:
                hud_position[:] = [1950, 574]
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            width=900,
            height=70,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        expected_move = [
            "hyprctl",
            "dispatch",
            'hl.dsp.window.move({ x = 1950, y = 574, window = "address:0xabc" })',
        ]
        self.assertIn(expected_move, commands)
        self.assertEqual([1950, 574], hud_position)
        left_margin = hud_position[0] - 1920
        right_margin = 1920 + 960 - (hud_position[0] + 900)
        self.assertEqual(left_margin, right_margin)
        self.assertNotEqual(1920, hud_position[0])
        self.assertEqual(574, hud_position[1])

    def test_positioning_rejects_missing_observed_size(self) -> None:
        commands: list[list[str]] = []
        client_reads = 0

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal client_reads
            commands.append(command)
            if command[-1] == "clients":
                client_reads += 1
                client = {
                    "address": "0xabc",
                    "mapped": True,
                    "class": "omp-hud",
                    "floating": True,
                    "pinned": True,
                    "monitor": 1,
                    "at": [510, 994],
                }
                if client_reads == 1:
                    client["size"] = [900, 70]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps([client]), stderr=""
                )
            if command[-1] == "monitors":
                monitor = {
                    "id": 1, "x": 0, "y": 0, "width": 1920,
                    "height": 1080, "scale": 1,
                }
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps([monitor]), stderr=""
                )
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        with self.assertRaisesRegex(HyprctlError, "did not expose"):
            promote_hud_overlay(
                runner,
                attempts=1,
                delay=0,
                width=900,
                height=70,
                env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
            )

        self.assertTrue(any("window.move" in " ".join(command) for command in commands))

    def test_positioning_rejects_stale_observed_size(self) -> None:
        commands: list[list[str]] = []
        client_reads = 0

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            nonlocal client_reads
            commands.append(command)
            if command[-1] == "clients":
                client_reads += 1
                size = [900, 70] if client_reads == 1 else [1188, 70]
                client = {
                    "address": "0xabc",
                    "mapped": True,
                    "class": "omp-hud",
                    "floating": True,
                    "pinned": True,
                    "monitor": 1,
                    "size": size,
                    "at": [510, 994],
                }
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps([client]), stderr=""
                )
            if command[-1] == "monitors":
                monitor = {
                    "id": 1, "x": 0, "y": 0, "width": 1920,
                    "height": 1080, "scale": 1,
                }
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps([monitor]), stderr=""
                )
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        with self.assertRaisesRegex(HyprctlError, "did not expose"):
            promote_hud_overlay(
                runner,
                attempts=1,
                delay=0,
                width=900,
                height=70,
                env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
            )

        self.assertTrue(any("window.move" in " ".join(command) for command in commands))

    def test_fits_mapped_hud_to_scaled_monitor_before_positioning(self) -> None:
        commands: list[list[str]] = []
        hud_size = [1188, 70]
        hud_position = [1326, 253]

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "0xabc",
                        "mapped": True,
                        "class": "omp-hud",
                        "floating": True,
                        "pinned": True,
                        "monitor": 1,
                        "size": hud_size,
                        "at": hud_position,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [
                    {
                        "id": 1,
                        "x": 1440,
                        "y": 0,
                        "width": 1920,
                        "height": 1080,
                        "scale": 2,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.resize" in dispatched:
                hud_size[:] = [928, 70]
            elif "window.move" in dispatched:
                hud_position[:] = [1456, 454]
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            width=1188,
            height=70,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        resize = [
            "hyprctl",
            "dispatch",
            'hl.dsp.window.resize({ x = 928, y = 70, window = "address:0xabc" })',
        ]
        move = [
            "hyprctl",
            "dispatch",
            'hl.dsp.window.move({ x = 1456, y = 454, window = "address:0xabc" })',
        ]
        self.assertLess(commands.index(resize), commands.index(move))
        self.assertEqual([928, 70], hud_size)
        self.assertEqual([1456, 454], hud_position)
        self.assertEqual(16, hud_position[0] - 1440)
        self.assertEqual(16, 1440 + 960 - (hud_position[0] + hud_size[0]))
        self.assertEqual(16, 540 - (hud_position[1] + hud_size[1]))

    def test_resize_failure_prevents_hud_placement(self) -> None:
        commands: list[list[str]] = []

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [{
                    "address": "0xabc", "mapped": True, "class": "omp-hud",
                    "floating": True, "pinned": True, "monitor": 1,
                    "size": [1188, 70], "at": [1326, 253],
                }]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [{
                    "id": 1, "x": 1440, "y": 0, "width": 1920,
                    "height": 1080, "scale": 2,
                }]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            return subprocess.CompletedProcess(
                command, 0, stdout="Invalid dispatcher\n", stderr=""
            )

        with self.assertRaisesRegex(HyprctlError, "resizewindowpixel failed"):
            promote_hud_overlay(
                runner,
                attempts=1,
                delay=0,
                width=1188,
                height=70,
                env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
            )

        self.assertFalse(any("window.move" in " ".join(command) for command in commands))
        self.assertFalse(any("movewindowpixel" in command for command in commands))

    def test_resize_uses_legacy_dispatch_when_lua_is_unavailable(self) -> None:
        commands: list[list[str]] = []
        hud_size = [1188, 70]
        hud_position = [0, 0]

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [{
                    "address": "0xabc", "mapped": True, "class": "omp-hud",
                    "floating": True, "pinned": True, "monitor": 1,
                    "size": hud_size, "at": hud_position,
                }]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [{
                    "id": 1, "x": 1440, "y": 0, "width": 1920,
                    "height": 1080, "scale": 2,
                }]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.resize" in dispatched:
                return subprocess.CompletedProcess(
                    command, 0, stdout="Invalid dispatcher\n", stderr=""
                )
            if dispatched == "resizewindowpixel":
                hud_size[:] = [928, 70]
            elif "window.move" in dispatched:
                hud_position[:] = [1456, 454]
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            width=1188,
            height=70,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        self.assertIn(
            [
                "hyprctl", "dispatch", "resizewindowpixel",
                "exact 928 70,address:0xabc",
            ],
            commands,
        )

    def test_calculates_position_for_offset_fractionally_scaled_monitor(self) -> None:
        position = _calculate_hud_position(
            {
                "x": -2048,
                "y": 80,
                "width": 2560,
                "height": 1440,
                "scale": 1.25,
            },
            width=1600,
            height=96,
            bottom_margin=24,
        )

        self.assertEqual((-1824, 1112), position)
        self.assertEqual(
            position[0] - (-2048),
            -2048 + 2048 - (position[0] + 1600),
        )

    def test_rejects_hud_wider_than_monitor_logical_width(self) -> None:
        with self.assertRaisesRegex(HyprctlError, "logical bounds"):
            _calculate_hud_position(
                {
                    "x": 1920,
                    "y": 120,
                    "width": 1920,
                    "height": 1080,
                    "scale": 2,
                },
                width=1188,
                height=70,
                bottom_margin=16,
            )

    def test_position_uses_legacy_dispatch_when_lua_is_unavailable(self) -> None:
        commands: list[list[str]] = []
        hud_position = [0, 0]

        def runner(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(command)
            if command[-1] == "clients":
                payload = [
                    {
                        "address": "0xabc",
                        "mapped": True,
                        "class": "omp-hud",
                        "floating": True,
                        "pinned": True,
                        "monitor": 7,
                        "size": [1200, 800],
                        "at": hud_position,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            if command[-1] == "monitors":
                payload = [
                    {
                        "id": 7,
                        "focused": True,
                        "x": 0,
                        "y": 0,
                        "width": 2000,
                        "height": 1200,
                        "scale": 1,
                    }
                ]
                return subprocess.CompletedProcess(
                    command, 0, stdout=json.dumps(payload), stderr=""
                )
            dispatched = command[2] if len(command) > 2 else ""
            if "window.move" in dispatched:
                return subprocess.CompletedProcess(
                    command, 0, stdout="Invalid dispatcher\n", stderr=""
                )
            if dispatched == "movewindowpixel":
                hud_position[:] = [400, 384]
            return subprocess.CompletedProcess(command, 0, stdout="ok\n", stderr="")

        promote_hud_overlay(
            runner,
            attempts=1,
            delay=0,
            width=1200,
            height=800,
            bottom_margin=16,
            env={"HYPRLAND_INSTANCE_SIGNATURE": "test"},
        )

        self.assertIn(
            [
                "hyprctl",
                "dispatch",
                "movewindowpixel",
                "exact 400 384,address:0xabc",
            ],
            commands,
        )


class CarouselLayoutTests(unittest.TestCase):
    def test_centers_active_with_left_and_right_peeks(self) -> None:
        monitor = CarouselMonitor(0, 0, 0, 1440, 900, (0, 0, 0, 0))
        slots = {
            slot.role: slot
            for slot in compute_carousel_slots(
                monitor, ["0xa", "0xb", "0xc"], "0xb"
            )
        }
        self.assertEqual({"active", "left", "right"}, set(slots))
        active = slots["active"]
        self.assertEqual("0xb", active.address)
        # 0.72 * (1440 - 80) = 979.2 → 979; 0.82 * (900 - 86 - 80) = 602.68 → 603? use bounds
        self.assertGreaterEqual(active.width, 900)
        self.assertGreaterEqual(active.height, 500)
        self.assertGreater(active.x, 0)
        self.assertGreater(active.y, 0)
        self.assertLess(slots["left"].x + slots["left"].width, active.x)
        self.assertGreater(slots["right"].x, active.x + active.width)

    def test_auto_stage_defaults_on(self) -> None:
        self.assertTrue(auto_stage_enabled({}))
        self.assertFalse(auto_stage_enabled({"OMP_HUD_AUTO_STAGE": "0"}))


class PromoteHudTests(unittest.TestCase):
    def test_promote_reports_missing_hyprland(self) -> None:
        with self.assertRaisesRegex(HyprctlError, "Hyprland is unavailable"):
            promote_hud_overlay(attempts=1, env={})


if __name__ == "__main__":
    unittest.main()
