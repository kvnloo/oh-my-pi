from __future__ import annotations

import subprocess
import threading
import unittest

from omp_hud.hyprland import ContextMonitor, HyprctlError, HyprlandContext, read_context


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

        monitor = ContextMonitor(on_context, self.fail, interval=0.01, reader=reader)
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

        monitor = ContextMonitor(on_context, errors.append, interval=0.01, reader=reader)
        monitor.start()
        self.assertTrue(restored.wait(1.0))
        monitor.stop()

        self.assertEqual([context, context], observed)
        self.assertEqual(["temporary failure"], errors)


if __name__ == "__main__":
    unittest.main()
