from __future__ import annotations

import importlib.util
import json
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest import mock


SCRIPT = Path(__file__).with_name("test-handsfree-e2e.py")


def load_harness() -> ModuleType:
    spec = importlib.util.spec_from_file_location("test_handsfree_e2e", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


HARNESS = load_harness()


def args(root: Path, *, dry_run: bool = False, timeout: float = 30.0, workflow: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        dry_run=dry_run,
        timeout=timeout,
        workflow=workflow,
        evidence=root / "evidence.json",
        screenshot=root / "capture.png",
    )


class FakeRunner:
    def __init__(self, responses: list[subprocess.CompletedProcess[str]] | None = None) -> None:
        self.responses = list(responses or [])
        self.calls: list[dict[str, object]] = []

    def run(
        self,
        argv: list[str],
        *,
        timeout: float,
        check: bool = True,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        command = [str(part) for part in argv]
        self.calls.append(
            {"argv": command, "timeout": timeout, "check": check, "input_text": input_text}
        )
        if self.responses:
            result = self.responses.pop(0)
            return subprocess.CompletedProcess(command, result.returncode, result.stdout, result.stderr)
        return subprocess.CompletedProcess(command, 0, "", "")

    @property
    def commands(self) -> list[list[str]]:
        return [call["argv"] for call in self.calls]  # type: ignore[misc]

def completed(stdout: object = "", returncode: int = 0, stderr: str = "") -> subprocess.CompletedProcess[str]:
    text = stdout if isinstance(stdout, str) else json.dumps(stdout)
    return subprocess.CompletedProcess([], returncode, text, stderr)


class PlanTest(unittest.TestCase):
    def test_unique_plan_uses_direct_detached_dispatch_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_runner, second_runner = FakeRunner(), FakeRunner()
            first = HARNESS.HandsfreeHarness(args(root, dry_run=True), first_runner)
            second = HARNESS.HandsfreeHarness(args(root, dry_run=True), second_runner)
            first.launch()
            second.launch()

            self.assertNotEqual(first.token, second.token)
            self.assertNotEqual(first.output, second.output)
            self.assertNotEqual(first.workspace, second.workspace)
            self.assertTrue(first.token.startswith("OMP_HANDSFREE_E2E_"))
            self.assertEqual(len(first_runner.commands), 3)
            for command in first_runner.commands:
                self.assertEqual(command[:2], ["hyprctl", "dispatch"])
                self.assertEqual(len(command), 3)
                self.assertIn("hl.dsp.exec_cmd", command[2])
                self.assertIn("OMP_HUD_E2E_NO_PIN=1", command[2])
                self.assertIn(f"OMP_E2E_MONITOR={first.output}", command[2])
                self.assertIn(f"OMP_E2E_WORKSPACE={first.workspace}", command[2])
                self.assertIn(f'workspace = "name:{first.workspace}"', command[2])
                self.assertIn(f'monitor = "{first.output}"', command[2])
                self.assertIn("no_initial_focus = true", command[2])
            self.assertFalse(any("keyword" in command or "source" in command for command in first_runner.commands))

    def test_output_creation_uses_unique_name_directly(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner()
            harness = HARNESS.HandsfreeHarness(args(Path(directory), dry_run=True), runner)
            harness.create_output()
            self.assertEqual(
                runner.commands,
                [["hyprctl", "output", "create", "headless", harness.output]],
            )
            self.assertIn(
                {"name": "output-create-planned", "passed": True, "detail": harness.output},
                harness.evidence["checks"],
            )

    def test_direct_lua_dispatch_maps_workspace_output_and_no_initial_focus_atomically(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner([completed("ok")])
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            harness.token = "TOKEN_DIRECT"
            harness.output = "OUTPUT_DIRECT"
            harness.workspace = "WORKSPACE_DIRECT"
            harness.dispatch_exec(["example", "arg with spaces"])
            command = runner.commands[0]
            self.assertEqual(command[:2], ["hyprctl", "dispatch"])
            self.assertEqual(len(command), 3)
            lua = command[2]
            self.assertIn('workspace = "name:WORKSPACE_DIRECT"', lua)
            self.assertIn('monitor = "OUTPUT_DIRECT"', lua)
            self.assertIn("no_initial_focus = true", lua)
            self.assertIn("OMP_HANDSFREE_E2E_TOKEN=TOKEN_DIRECT", lua)
            self.assertEqual(lua.count("hl.dsp.exec_cmd"), 1)

    def test_hud_launch_matches_zero_argument_sanity_command_and_derived_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner([completed("ok"), completed("ok"), completed("ok")])
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            harness.token = "TOKEN_DIRECT_HUD"
            harness.log_path = Path(tempfile.gettempdir()) / f"{harness.token}.log"
            harness.output = "OUTPUT_DIRECT_HUD"
            harness.workspace = "WORKSPACE_DIRECT_HUD"

            harness.launch()

            script_root = SCRIPT.resolve().parent.parent
            launcher = script_root / "scripts" / "omp-handsfree"
            expected_command = (
                f"env OMP_HANDSFREE_E2E_TOKEN={harness.token} "
                f"OMP_HUD_E2E_NO_PIN=1 OMP_E2E_MONITOR={harness.output} "
                f"OMP_E2E_WORKSPACE={harness.workspace} {launcher}"
            )
            expected_dispatch = (
                f"hl.dsp.exec_cmd({json.dumps(expected_command)}, "
                f'{{ workspace = "name:{harness.workspace}", '
                f'monitor = "{harness.output}", no_initial_focus = true }})'
            )
            self.assertEqual(
                runner.commands[-1],
                ["hyprctl", "dispatch", expected_dispatch],
            )
            self.assertEqual(
                harness.log_path,
                Path(tempfile.gettempdir()) / f"{harness.token}.log",
            )
            self.assertEqual(
                harness.evidence["hud_launch"],
                {
                    "command": [str(launcher)],
                    "cwd": str(script_root),
                    "log": str(harness.log_path),
                },
            )

    def test_hud_launcher_processes_match_launcher_and_python_module_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            commands = {
                101: b"kitty\0--title\0fixture\0-m\0omp_hud\0sh\0-c\0exec sleep 86400\0",
                102: b"sleep\086400\0",
                103: b"/bin/sh\0/project/scripts/omp-handsfree\0",
                104: b"python3\0-m\0omp_hud\0--cwd\0/project\0",
            }

            def read_cmdline(path: Path) -> bytes:
                return commands[int(path.parent.name)]

            with mock.patch.object(
                harness, "token_processes", return_value=set(commands)
            ), mock.patch.object(
                HARNESS.Path, "read_bytes", autospec=True, side_effect=read_cmdline
            ):
                self.assertEqual(harness.hud_launcher_processes(), {103, 104})

    def test_fixture_processes_cannot_hide_early_launcher_death(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), timeout=30.0))
            harness.hud_launch_started_at = 100.0
            fixtures = [
                {"class": f"{harness.token}-fixture-one"},
                {"class": f"{harness.token}-fixture-two"},
            ]
            commands = {
                101: b"kitty\0--title\0fixture one\0sh\0-c\0exec sleep 86400\0",
                102: b"sleep\086400\0",
            }

            def read_cmdline(path: Path) -> bytes:
                return commands[int(path.parent.name)]

            with mock.patch.object(
                harness, "token_clients", return_value=fixtures
            ), mock.patch.object(
                harness, "token_processes", return_value=set(commands)
            ), mock.patch.object(
                HARNESS.Path, "read_bytes", autospec=True, side_effect=read_cmdline
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=115.0
            ), mock.patch.object(HARNESS.time, "sleep"):
                with self.assertRaisesRegex(
                    HARNESS.HarnessError,
                    "HUD launcher exited before client became ready",
                ):
                    harness.wait_for_clients()

    def test_token_owned_main_module_client_with_exact_title_is_hud(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.output_id = 9
            harness.workspace = "DETACHED"
            fixtures = [
                {
                    "address": f"0x{pid}",
                    "pid": pid,
                    "class": f"{harness.token}-fixture-{label}",
                    "monitor": 9,
                    "workspace": {"name": "DETACHED"},
                }
                for pid, label in ((101, "one"), (102, "two"))
            ]
            hud = {
                "address": "0x103",
                "pid": 103,
                "class": "__main__.py",
                "title": "OMP Handsfree Mode",
                "monitor": 9,
                "workspace": {"name": "DETACHED"},
            }
            with mock.patch.object(
                harness, "token_clients", return_value=[*fixtures, hud]
            ), mock.patch.object(
                harness, "token_in_environ", return_value=True
            ), mock.patch.object(
                harness, "token_processes", return_value={101, 102, 103}
            ):
                clients, selected = harness.wait_for_clients()
            self.assertEqual(clients, [*fixtures, hud])
            self.assertIs(selected, hud)

    def test_same_title_unowned_client_is_not_selected_as_hud(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            fixtures = [
                {"address": f"0x{pid}", "pid": pid, "class": f"{harness.token}-fixture-{pid}"}
                for pid in (101, 102)
            ]
            collision = {
                "address": "0x999",
                "pid": 999,
                "class": "__main__.py",
                "title": "OMP Handsfree Mode",
            }
            with mock.patch.object(
                harness, "query", return_value=[*fixtures, collision]
            ), mock.patch.object(
                harness, "token_in_environ", side_effect=lambda pid: pid != 999
            ) as ownership, mock.patch.object(
                harness, "hud_launcher_processes", return_value={4444}
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=harness.deadline
            ):
                with self.assertRaisesRegex(
                    HARNESS.HarnessError, "timed out resolving two fixtures and one HUD"
                ):
                    harness.wait_for_clients()
            self.assertIn(mock.call(999), ownership.call_args_list)

    def test_multiple_token_owned_exact_title_clients_are_ambiguous(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            fixtures = [
                {"address": f"0x{pid}", "pid": pid, "class": f"{harness.token}-fixture-{pid}"}
                for pid in (101, 102)
            ]
            hud_candidates = [
                {
                    "address": f"0x{pid}",
                    "pid": pid,
                    "class": class_name,
                    "title": "OMP Handsfree Mode",
                }
                for pid, class_name in ((103, "__main__.py"), (104, "omp-hud"))
            ]
            with mock.patch.object(
                harness, "token_clients", return_value=[*fixtures, *hud_candidates]
            ), mock.patch.object(
                harness, "hud_launcher_processes", return_value={4444}
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=harness.deadline
            ):
                with self.assertRaisesRegex(
                    HARNESS.HarnessError, "timed out resolving two fixtures and one HUD"
                ):
                    harness.wait_for_clients()

    def test_two_fixtures_without_hud_process_keep_polling_during_launch_grace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), timeout=30.0))
            harness.hud_launch_started_at = 100.0
            fixtures = [
                {"class": f"{harness.token}-fixture-one"},
                {"class": f"{harness.token}-fixture-two"},
            ]
            with mock.patch.object(
                harness,
                "token_clients",
                side_effect=[fixtures, AssertionError("continued polling")],
            ) as token_clients, mock.patch.object(
                harness, "hud_launcher_processes", return_value=set()
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=100.5
            ), mock.patch.object(
                HARNESS.time, "sleep"
            ) as sleep:
                with self.assertRaisesRegex(AssertionError, "continued polling"):
                    harness.wait_for_clients()
            self.assertEqual(token_clients.call_count, 2)
            sleep.assert_called_once_with(0.1)

    def test_missing_hud_process_after_launch_grace_raises_with_hud_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), timeout=30.0))
            harness.log_path.write_text("fatal: HUD bootstrap failed\n", encoding="utf-8")
            harness.hud_launch_started_at = 100.0
            fixtures = [
                {"class": f"{harness.token}-fixture-one"},
                {"class": f"{harness.token}-fixture-two"},
            ]
            with mock.patch.object(
                harness, "token_clients", return_value=fixtures
            ), mock.patch.object(
                harness, "hud_launcher_processes", return_value=set()
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=115.0
            ), mock.patch.object(HARNESS.time, "sleep"):
                with self.assertRaisesRegex(
                    HARNESS.HarnessError,
                    "(?s)HUD launcher exited before client became ready.*fatal: HUD bootstrap failed",
                ):
                    harness.wait_for_clients()

    def test_seen_hud_process_disappearing_during_grace_raises_with_hud_log(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), timeout=30.0))
            harness.log_path.write_text("fatal: HUD bootstrap failed\n", encoding="utf-8")
            harness.hud_launch_started_at = 100.0
            fixtures = [
                {"class": f"{harness.token}-fixture-one"},
                {"class": f"{harness.token}-fixture-two"},
            ]
            with mock.patch.object(
                harness, "token_clients", return_value=fixtures
            ), mock.patch.object(
                harness, "hud_launcher_processes", side_effect=[{4321}, set()]
            ), mock.patch.object(
                HARNESS.time, "monotonic", return_value=100.5
            ), mock.patch.object(
                HARNESS.time, "sleep"
            ) as sleep:
                with self.assertRaisesRegex(
                    HARNESS.HarnessError,
                    "(?s)HUD launcher exited before client became ready.*fatal: HUD bootstrap failed",
                ):
                    harness.wait_for_clients()
            sleep.assert_called_once_with(0.1)

    def test_dispatcher_failure_aborts_launch_before_polling(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner([completed("unknown dispatcher")])
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            with mock.patch.object(harness, "wait_for_clients") as wait_for_clients:
                with self.assertRaisesRegex(HARNESS.HarnessError, "dispatch"):
                    harness.launch()
            self.assertEqual(len(runner.commands), 1)
            self.assertEqual(runner.commands[0][:2], ["hyprctl", "dispatch"])
            wait_for_clients.assert_not_called()

    def test_screenshot_and_evidence_are_explicit_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = FakeRunner()
            harness = HARNESS.HandsfreeHarness(args(root, dry_run=True), runner)
            harness.capture()
            harness.write_evidence()
            self.assertEqual(runner.commands, [["grim", "-o", harness.output, str(root / "capture.png")]])
            written = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
            self.assertEqual(written["output"], harness.output)
            self.assertEqual(written["token"], harness.token)
            self.assertIn({"name": "screenshot-captured", "passed": True, "detail": str(root / "capture.png")}, written["checks"])


class OwnershipAndAtspiTest(unittest.TestCase):
    def test_token_clients_require_pid_environ_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clients = [
                {"pid": 101, "title": "owned"},
                {"pid": 202, "title": "same token text but foreign"},
                {"title": "missing pid"},
            ]
            runner = FakeRunner([completed(clients)])
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            with mock.patch.object(harness, "token_in_environ", side_effect=lambda pid: pid == 101) as ownership:
                self.assertEqual(harness.token_clients(), [clients[0]])
            self.assertEqual([call.args[0] for call in ownership.call_args_list], [101, 202])

    def test_environ_must_contain_exact_token_assignment(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.token = "EXACT"
            with mock.patch.object(Path, "read_bytes", return_value=b"A=1\0OMP_HANDSFREE_E2E_TOKEN=EXACTISH\0"):
                self.assertFalse(harness.token_in_environ(77))
            with mock.patch.object(Path, "read_bytes", return_value=b"A=1\0OMP_HANDSFREE_E2E_TOKEN=EXACT\0"):
                self.assertTrue(harness.token_in_environ(77))

    def test_atspi_probe_is_pid_scoped_and_title_collision_is_not_accepted(self) -> None:
        class AtspiRunner(FakeRunner):
            def run(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
                result = super().run(argv, **kwargs)
                probe = self.commands[-1]
                expected_pid = "4242"
                if (
                    len(probe) < 5
                    or probe[0] != "python3"
                    or not str(probe[1]).endswith("handsfree_atspi_probe.py")
                    or probe[2] != expected_pid
                ):
                    return completed("", 1, "title-only collision accepted")
                source = Path(probe[1]).read_text(encoding="utf-8")
                if "process_id(n) == pid" not in source:
                    return completed("", 1, "probe did not bind accessibility tree to PID")
                return completed(
                    {
                        "pid": 4242,
                        "window_count": 1,
                        "choices": 2,
                        "cycled": True,
                        "microphone_enabled": True,
                    }
                )

        with tempfile.TemporaryDirectory() as directory:
            runner = AtspiRunner()
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            harness.token = "COLLIDING_TITLE_TOKEN"
            harness.inspect_atspi(4242)
            command = runner.commands[0]
            self.assertEqual(command[0], "python3")
            self.assertTrue(str(command[1]).endswith("handsfree_atspi_probe.py"))
            self.assertEqual(command[2:4], ["4242", "COLLIDING_TITLE_TOKEN"])
            check = harness.evidence["checks"][-1]
            self.assertEqual(check["name"], "atspi-pid-scoped")
            self.assertEqual(check["detail"]["pid"], 4242)


class CleanupTest(unittest.TestCase):
    def make_harness(self, root: Path, runner: FakeRunner) -> object:
        harness = HARNESS.HandsfreeHarness(args(root), runner)
        harness.token = "CLEANUP_TOKEN"
        harness.output = "CLEANUP_OUTPUT"
        harness.output_created = True
        harness.owned_pids = {20, 10, 30}
        original_window = {
            "address": "0xabc",
            "pid": 7,
            "workspace": {"name": "1"},
            "monitor": 0,
            "at": [4, 5],
            "size": [800, 600],
            "class": "editor",
            "title": "work",
        }
        harness.original = {
            "activewindow": "0xabc",
            "activeworkspace": {"id": 1, "name": "1"},
            "clients": {"0xabc": HARNESS.HandsfreeHarness.window_snapshot(original_window)},
            "client_metadata": {
                "0xabc": {"pid": 7, "class": "editor", "title": "work"}
            },
        }
        return harness

    def test_exact_termination_skips_pid_whose_ownership_cannot_be_reverified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory), FakeRunner())
            with mock.patch.object(harness, "token_in_environ", side_effect=lambda pid: pid in {10, 30}), mock.patch.object(HARNESS.os, "kill") as kill:
                harness.kill_verified(signal.SIGTERM)
            self.assertEqual(kill.call_args_list, [mock.call(10, signal.SIGTERM), mock.call(30, signal.SIGTERM)])
            skipped = [event for event in harness.evidence["cleanup"] if event.get("skipped")]
            self.assertEqual([event["pid"] for event in skipped], [20])

    def test_previous_leakage_bug_leaves_output_intact_when_client_survives(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner()
            harness = self.make_harness(Path(directory), runner)
            survivor = {"pid": 10, "address": "0xleak", "class": "omp-hud"}
            with mock.patch.object(harness, "token_processes", return_value={10}), mock.patch.object(harness, "kill_verified") as terminate, mock.patch.object(harness, "wait_for_stable_zero", return_value=(False, [{"client_addresses": ["0xleak"], "processes": [10]}])), mock.patch.object(harness, "token_clients", return_value=[survivor]):
                with self.assertRaisesRegex(HARNESS.HarnessError, "output deliberately left intact"):
                    harness.cleanup()
            self.assertEqual(terminate.call_args_list, [mock.call(signal.SIGTERM), mock.call(signal.SIGKILL)])
            self.assertFalse(any(command[:3] == ["hyprctl", "output", "remove"] for command in runner.commands))
            self.assertTrue(harness.output_created)
            failed_proof = next(entry for entry in harness.evidence["cleanup"] if entry["action"] == "stable-zero-proof")
            self.assertFalse(failed_proof["passed"])

    def test_escalation_signals_only_still_verified_owned_pids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory), FakeRunner())
            proof = {10: True, 20: False, 30: True}
            signals: list[tuple[int, int]] = []
            with mock.patch.object(harness, "token_processes", return_value={10, 20, 30}), mock.patch.object(harness, "token_in_environ", side_effect=lambda pid: proof[pid]), mock.patch.object(harness, "wait_for_stable_zero", return_value=(False, [{"client_addresses": ["0x30"], "processes": [30]}])), mock.patch.object(harness, "token_clients", return_value=[{"pid": 30}]), mock.patch.object(HARNESS.os, "kill", side_effect=lambda pid, sig: signals.append((pid, sig))):
                with self.assertRaisesRegex(HARNESS.HarnessError, "output deliberately left intact"):
                    harness.cleanup()
            self.assertEqual(signals, [(10, signal.SIGTERM), (30, signal.SIGTERM), (10, signal.SIGKILL), (30, signal.SIGKILL)])

    def test_output_removed_only_after_zero_clients_then_absence_is_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            original_window = {"address": "0xabc", "pid": 7, "workspace": {"name": "1"}, "monitor": 0, "at": [4, 5], "size": [800, 600], "class": "editor", "title": "work"}
            original_workspace = {"id": 1, "name": "1", "monitor": "REAL"}
            runner = FakeRunner([completed(), completed([]), completed(), completed([original_window]), completed(original_window), completed(original_workspace)])
            harness = self.make_harness(Path(directory), runner)
            stable_zero_observations: list[bool] = []
            def stable_zero(*_: object, **__: object) -> tuple[bool, list[dict[str, object]]]:
                stable_zero_observations.append(True)
                return True, [{"client_addresses": [], "processes": []}]
            with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(harness, "kill_verified"), mock.patch.object(harness, "wait_for_stable_zero", side_effect=stable_zero), mock.patch.object(harness, "token_clients", return_value=[]):
                harness.cleanup()
            self.assertIn(["hyprctl", "output", "remove", "CLEANUP_OUTPUT"], runner.commands)
            actions = [entry["action"] for entry in harness.evidence["cleanup"]]
            self.assertLess(actions.index("stable-zero-proof"), actions.index("remove-output"))
            self.assertIn("original-state-restored", actions)
            self.assertFalse(harness.output_created)
            self.assertEqual(stable_zero_observations, [True])

    def test_dynamic_title_and_class_do_not_change_original_placement_or_focus(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory), FakeRunner())
            original = harness.original["clients"]["0xabc"]
            current = dict(original, title="shell renamed itself", **{"class": "editor-dialog"})
            active = dict(current)
            with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(
                harness, "kill_verified"
            ), mock.patch.object(
                harness, "wait_for_stable_zero", return_value=(True, [])
            ), mock.patch.object(
                harness,
                "query",
                side_effect=lambda name, **_: (
                    []
                    if name == "monitors"
                    else [current]
                    if name == "clients"
                    else active
                    if name == "activewindow"
                    else {"id": 1, "name": "1", "monitor": "RENAMED"}
                ),
            ):
                harness.cleanup()

    def test_pinned_pre_existing_client_may_follow_active_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory), FakeRunner())
            original = dict(
                harness.original["clients"]["0xabc"],
                floating=True,
                pinned=True,
            )
            harness.original["clients"]["0xabc"] = original
            current = dict(original, workspace={"name": "2"})
            with mock.patch.object(
                harness, "token_processes", return_value=set()
            ), mock.patch.object(
                harness, "kill_verified"
            ), mock.patch.object(
                harness, "wait_for_stable_zero", return_value=(True, [])
            ), mock.patch.object(
                harness,
                "query",
                side_effect=lambda name, **_: (
                    []
                    if name == "monitors"
                    else [current]
                    if name == "clients"
                    else current
                    if name == "activewindow"
                    else {"id": 1, "name": "1", "monitor": "REAL"}
                ),
            ):
                harness.cleanup()

    def test_pinned_pre_existing_client_keeps_non_workspace_invariants(self) -> None:
        mutations = {
            "address": {"address": "0xdef"},
            "monitor": {"monitor": 1},
            "at": {"at": [40, 50]},
            "size": {"size": [900, 700]},
            "floating": {"floating": False},
            "pinned": {"pinned": False},
        }
        for invariant, mutation in mutations.items():
            with self.subTest(invariant=invariant), tempfile.TemporaryDirectory() as directory:
                harness = self.make_harness(Path(directory), FakeRunner())
                original = dict(
                    harness.original["clients"]["0xabc"],
                    floating=True,
                    pinned=True,
                )
                harness.original["clients"]["0xabc"] = original
                current = dict(original, workspace={"name": "2"}, **mutation)
                with mock.patch.object(
                    harness, "token_processes", return_value=set()
                ), mock.patch.object(
                    harness, "kill_verified"
                ), mock.patch.object(
                    harness, "wait_for_stable_zero", return_value=(True, [])
                ), mock.patch.object(
                    harness,
                    "query",
                    side_effect=lambda name, **_: (
                        []
                        if name == "monitors"
                        else [current]
                        if name == "clients"
                        else current
                        if name == "activewindow"
                        else {"id": 1, "name": "1", "monitor": "REAL"}
                    ),
                ):
                    with self.assertRaisesRegex(
                        HARNESS.HarnessError, "pre-existing client"
                    ):
                        harness.cleanup()

    def test_original_placement_and_focus_invariants_each_still_fail(self) -> None:
        mutations = {
            "address": lambda clients, active, workspace: ([dict(clients[0], address="0xdef")], active, workspace),
            "workspace": lambda clients, active, workspace: ([dict(clients[0], workspace={"name": "2"})], active, workspace),
            "monitor": lambda clients, active, workspace: ([dict(clients[0], monitor=1)], active, workspace),
            "at": lambda clients, active, workspace: ([dict(clients[0], at=[40, 50])], active, workspace),
            "size": lambda clients, active, workspace: ([dict(clients[0], size=[900, 700])], active, workspace),
            "floating": lambda clients, active, workspace: ([dict(clients[0], floating=True)], active, workspace),
            "active address": lambda clients, active, workspace: (clients, dict(active, address="0xdef"), workspace),
            "active workspace": lambda clients, active, workspace: (clients, active, dict(workspace, name="2")),
        }
        for invariant, mutate in mutations.items():
            with self.subTest(invariant=invariant), tempfile.TemporaryDirectory() as directory:
                harness = self.make_harness(Path(directory), FakeRunner())
                original = harness.original["clients"]["0xabc"]
                clients, active, workspace = mutate(
                    [dict(original)],
                    dict(original),
                    {"id": 1, "name": "1", "monitor": "REAL"},
                )
                with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(
                    harness, "kill_verified"
                ), mock.patch.object(
                    harness, "wait_for_stable_zero", return_value=(True, [])
                ), mock.patch.object(
                    harness,
                    "query",
                    side_effect=lambda name, **_: (
                        []
                        if name == "monitors"
                        else clients
                        if name == "clients"
                        else active
                        if name == "activewindow"
                        else workspace
                    ),
                ):
                    with self.assertRaisesRegex(
                        HARNESS.HarnessError,
                        "pre-existing client|original focus",
                    ):
                        harness.cleanup()

    def test_cleanup_gets_independent_time_after_execution_deadline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory), FakeRunner())
            harness.output_created = False
            execution_deadline = HARNESS.time.monotonic() - 1.0
            harness.deadline = execution_deadline
            with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(
                harness, "kill_verified"
            ), mock.patch.object(
                harness, "wait_for_stable_zero", return_value=(True, [])
            ), mock.patch.object(
                harness,
                "query",
                side_effect=lambda name, **_: (
                    [harness.original["clients"]["0xabc"]]
                    if name == "clients"
                    else harness.original["clients"]["0xabc"]
                    if name == "activewindow"
                    else {"id": 1, "name": "1", "monitor": "CHANGED"}
                ),
            ):
                harness.cleanup()
            self.assertEqual(harness.deadline, execution_deadline)
            self.assertGreater(harness.cleanup_deadline, HARNESS.time.monotonic())


class StableRemovalProofTest(unittest.TestCase):
    def make_harness(self, root: Path, runner: FakeRunner | None = None) -> object:
        harness = HARNESS.HandsfreeHarness(args(root), runner or FakeRunner())
        harness.cleanup_deadline = harness.deadline
        harness.token = "STABLE_TOKEN"
        harness.output = "STABLE_OUTPUT"
        harness.output_created = True
        harness.original = {"activewindow": None, "activeworkspace": {"id": None, "name": None}, "clients": {}}
        return harness

    def test_token_process_survivor_blocks_removal_after_clients_vanish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory))
            samples = [
                ([], {41}),
                ([], {41}),
                ([], {41}),
            ]
            with mock.patch.object(
                harness, "token_clients", return_value=[]
            ), mock.patch.object(
                harness, "token_processes", side_effect=lambda: samples.pop(0)[1]
            ), mock.patch.object(
                HARNESS.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 0.3, 1.1]
            ), mock.patch.object(HARNESS.time, "sleep"):
                passed, proof = harness.wait_for_stable_zero(1.0, consecutive=3)
            self.assertFalse(passed)
            self.assertTrue(any(sample["processes"] == [41] for sample in proof))

    def test_transient_empty_sample_does_not_satisfy_stable_zero(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory))
            samples = iter(
                [
                    ([], set()),
                    ([{"pid": 12, "address": "0x12"}], {12}),
                    ([], set()),
                ]
            )

            def sample() -> tuple[list[dict[str, object]], set[int]]:
                current = next(samples)
                observed.append(current)
                return current

            observed: list[tuple[list[dict[str, object]], set[int]]] = []
            with mock.patch.object(
                harness, "token_clients", side_effect=lambda **_: sample()[0]
            ), mock.patch.object(
                harness, "token_processes", side_effect=lambda: observed[-1][1]
            ), mock.patch.object(
                HARNESS.time, "monotonic", side_effect=[0.0, 0.1, 0.2, 0.3, 1.1]
            ), mock.patch.object(HARNESS.time, "sleep"):
                passed, proof = harness.wait_for_stable_zero(1.0, consecutive=3)
            self.assertFalse(passed)
            self.assertEqual([entry["client_addresses"] for entry in proof], [[], ["0x12"], []])

    def test_three_consecutive_empty_client_and_process_samples_permit_removal(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = self.make_harness(Path(directory))
            with mock.patch.object(
                harness, "token_clients", return_value=[]
            ), mock.patch.object(
                harness, "token_processes", return_value=set()
            ), mock.patch.object(HARNESS.time, "sleep"):
                passed, proof = harness.wait_for_stable_zero(1.0, consecutive=3)
            self.assertTrue(passed)
            self.assertEqual(len(proof), 3)
            self.assertTrue(all(not sample["client_addresses"] and not sample["processes"] for sample in proof))

    def test_remove_command_success_with_monitor_remaining_is_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner()
            harness = self.make_harness(Path(directory), runner)
            with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(
                harness, "kill_verified"
            ), mock.patch.object(
                harness, "wait_for_stable_zero", return_value=(True, [{"stable_count": 3}])
            ), mock.patch.object(
                harness, "query", side_effect=lambda name, **_: [{"name": harness.output}] if name == "monitors" else {}
            ):
                with self.assertRaisesRegex(HARNESS.HarnessError, "still exists"):
                    harness.cleanup()
            self.assertTrue(harness.output_created)
            self.assertFalse(any(
                entry["action"] == "remove-output" and entry.get("passed")
                for entry in harness.evidence["cleanup"]
            ))


class EvidenceStrengthTest(unittest.TestCase):
    def test_screenshot_is_taken_only_after_hud_placement_is_verified(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            hud = {"pid": 77, "address": "0x77"}
            order: list[str] = []
            with mock.patch.object(harness, "snapshot_original"), mock.patch.object(
                harness, "create_output"
            ), mock.patch.object(harness, "launch"), mock.patch.object(
                harness, "wait_for_clients", return_value=([], hud)
            ), mock.patch.object(
                harness, "wait_for_hud_placement", side_effect=lambda client: order.append("placement")
            ), mock.patch.object(
                harness, "capture", side_effect=lambda: order.append("capture")
            ), mock.patch.object(harness, "inspect_atspi"), mock.patch.object(
                harness, "check_log"
            ), mock.patch.object(harness, "cleanup"), mock.patch.object(harness, "write_evidence"):
                harness.run()
            self.assertEqual(order, ["placement", "capture"])

    def test_scale_two_geometry_is_exactly_centered_and_bottom_aligned(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.output = "SCALED"
            harness.output_id = 9
            harness.workspace = "DETACHED"
            monitor = {
                "name": "SCALED", "id": 9, "x": 300, "y": 100,
                "width": 2560, "height": 1440, "scale": 2,
            }
            hud = {
                "address": "0xhud", "pid": 77, "monitor": 9,
                "workspace": {"name": "DETACHED"}, "at": [740, 724],
                "size": [400, 80], "floating": True, "pinned": False,
            }
            with mock.patch.object(
                harness,
                "query",
                side_effect=lambda name: [monitor] if name == "monitors" else [hud],
            ), mock.patch.object(HARNESS.time, "sleep"):
                geometry = harness.wait_for_hud_placement(hud)
            self.assertEqual(geometry["monitor_logical_size"], [1280, 720])
            self.assertEqual(geometry["expected_at"], [740, 724])
            self.assertEqual(geometry["hud_at"], geometry["expected_at"])
            self.assertEqual(geometry["bottom_margin"], 16)

    def test_atspi_probe_targets_real_key_scroll_and_ready_transition(self) -> None:
        class InteractionRunner(FakeRunner):
            def run(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
                super().run(argv, **kwargs)
                return completed(
                    {
                        "pid": 4242,
                        "window_count": 1,
                        "choices": 2,
                        "ready_control": "Prompt for selected desktop target",
                        "prompt_sensitive": True,
                        "microphone_enabled": True,
                        "keyboard": {"before": "A", "down": "B", "restored": "A"},
                        "scroll": {"before": "A", "down": "B", "restored": "A", "point": [10, 20]},
                    }
                )

        with tempfile.TemporaryDirectory() as directory:
            runner = InteractionRunner()
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            with mock.patch.object(
                harness,
                "token_clients",
                return_value=[{"pid": 4242, "address": "0x4242"}],
            ):
                harness.inspect_atspi(4242, "0x4242")
            detail = harness.evidence["checks"][-1]["detail"]
            self.assertEqual(detail["ready_control"], "Prompt for selected desktop target")
            self.assertTrue(detail["prompt_sensitive"])
            self.assertEqual(detail["keyboard"]["down"], "B")
            self.assertEqual(detail["scroll"]["down"], "B")
            self.assertEqual(runner.commands[0][2], "4242")
            self.assertEqual(runner.commands[0][5], "0x4242")
            probe_source = Path(runner.commands[0][1]).read_text(encoding="utf-8")
            self.assertIn("generate_keyboard_event", probe_source)
            self.assertIn("generate_mouse_event", probe_source)
            self.assertIn("process_id(n) == pid", probe_source)

    def test_change_to_any_preexisting_client_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), FakeRunner())
            first = {
                "address": "0x1", "pid": 1, "workspace": {"name": "1"}, "monitor": 0,
                "at": [1, 2], "size": [300, 200], "class": "one", "title": "one",
            }
            second = {
                "address": "0x2", "pid": 2, "workspace": {"name": "1"}, "monitor": 0,
                "at": [10, 20], "size": [400, 300], "class": "two", "title": "two",
            }
            harness.original = {
                "activewindow": "0x1",
                "activeworkspace": {"id": 1, "name": "1"},
                "clients": {
                    "0x1": harness.window_snapshot(first),
                    "0x2": harness.window_snapshot(second),
                },
            }
            changed = dict(second, size=[401, 300])
            with mock.patch.object(harness, "token_processes", return_value=set()), mock.patch.object(
                harness, "kill_verified"
            ), mock.patch.object(
                harness, "wait_for_stable_zero", return_value=(True, [])
            ), mock.patch.object(
                harness,
                "query",
                side_effect=lambda name, **_: (
                    []
                    if name == "monitors"
                    else [first, changed]
                    if name == "clients"
                    else first
                    if name == "activewindow"
                    else {"id": 1, "name": "1", "monitor": "REAL"}
                ),
            ):
                with self.assertRaisesRegex(HARNESS.HarnessError, "pre-existing client"):
                    harness.cleanup()

    def test_missing_log_is_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            self.assertFalse(harness.log_path.exists())
            with self.assertRaisesRegex(HARNESS.HarnessError, "log"):
                harness.check_log()

    def test_all_toolkit_and_overlay_diagnostics_are_failures(self) -> None:
        diagnostics = (
            "Gtk-WARNING **: gtk warning",
            "Gdk-ERROR **: gdk error",
            "GLib-CRITICAL **: glib critical",
            "overlay error: failed to paint HUD",
        )
        for diagnostic in diagnostics:
            with self.subTest(diagnostic=diagnostic), tempfile.TemporaryDirectory() as directory:
                harness = HARNESS.HandsfreeHarness(args(Path(directory)))
                harness.log_path.write_text(diagnostic + "\n", encoding="utf-8")
                with self.assertRaisesRegex(HARNESS.HarnessError, "diagnostic"):
                    harness.check_log()


class FailurePathTest(unittest.TestCase):
    def test_timeout_still_cleans_up_and_writes_failed_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            harness = HARNESS.HandsfreeHarness(args(root, dry_run=True))
            with mock.patch.object(harness, "snapshot_original", side_effect=HARNESS.HarnessError("harness timeout expired")), mock.patch.object(harness, "cleanup") as cleanup:
                with self.assertRaisesRegex(HARNESS.HarnessError, "timeout expired"):
                    harness.run()
            cleanup.assert_called_once_with()
            evidence = json.loads((root / "evidence.json").read_text(encoding="utf-8"))
            self.assertEqual(evidence["status"], "failed")
            self.assertIn("timeout", evidence["error"])

    def test_signal_handler_interrupts_but_run_finally_cleans_up(self) -> None:
        installed: dict[int, object] = {}
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), dry_run=True))

            def interrupt_from_snapshot() -> None:
                installed[signal.SIGTERM](signal.SIGTERM, None)  # type: ignore[operator]

            with mock.patch.object(HARNESS, "HandsfreeHarness", return_value=harness), mock.patch.object(HARNESS, "parse_args", return_value=harness.args), mock.patch.object(harness, "snapshot_original", side_effect=interrupt_from_snapshot), mock.patch.object(harness, "cleanup") as cleanup, mock.patch.object(HARNESS.signal, "signal", side_effect=lambda sig, handler: installed.__setitem__(sig, handler) if callable(handler) else None), mock.patch.object(HARNESS, "print"):
                self.assertEqual(HARNESS.main([]), 1)
            cleanup.assert_called_once_with()
            self.assertEqual(harness.interrupted, signal.SIGTERM)
            evidence = json.loads(harness.args.evidence.read_text(encoding="utf-8"))
            self.assertEqual(evidence["status"], "failed")

    def test_gtk_warning_is_a_hard_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.log_path.write_text("Gtk-WARNING **: leaked widget\n", encoding="utf-8")
            with self.assertRaisesRegex(HARNESS.HarnessError, "diagnostics"):
                harness.check_log()
            self.assertFalse(any(check["name"] == "gtk-log-clean" for check in harness.evidence["checks"]))


class WorkflowGateTest(unittest.TestCase):
    def test_dry_run_workflow_records_planned_checks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory), dry_run=True, workflow=True))
            harness.run_developer_workflow()
            names = [check["name"] for check in harness.evidence["checks"]]
            self.assertEqual(names, ["workflow-planned"])
            self.assertEqual(
                harness.evidence["checks"][0]["detail"],
                ["kitty-echo", "firefox-google", "tile", "headless-gate"],
            )

    def test_assert_client_gated_rejects_wrong_monitor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.output = "HEADLESS"
            harness.output_id = 7
            harness.workspace = "ws-e2e"
            with mock.patch.object(harness, "token_in_environ", return_value=True):
                with self.assertRaisesRegex(HARNESS.HarnessError, "outside headless monitor"):
                    harness.assert_client_gated(
                        {
                            "address": "0xabc",
                            "monitor": 0,
                            "workspace": {"name": "ws-e2e"},
                            "pid": 42,
                        },
                        label="leaked",
                    )

    def test_gate_token_clients_rejects_workspace_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.output = "HEADLESS"
            harness.output_id = 7
            harness.workspace = "ws-e2e"
            clients = [
                {
                    "address": "0xgood",
                    "title": "ok",
                    "monitor": 7,
                    "workspace": {"name": "ws-e2e"},
                    "pid": 1,
                },
                {
                    "address": "0xbad",
                    "title": "escape",
                    "monitor": 7,
                    "workspace": {"name": "1"},
                    "pid": 2,
                },
            ]
            with mock.patch.object(harness, "token_clients", return_value=clients):
                with self.assertRaisesRegex(HARNESS.HarnessError, "escaped headless gate"):
                    harness.gate_token_clients()

    def test_tile_side_by_side_orders_left_and_right(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            harness = HARNESS.HandsfreeHarness(args(Path(directory)))
            harness.output = "HEADLESS"
            harness.output_id = 3
            harness.workspace = "ws-e2e"
            monitor = {
                "name": "HEADLESS",
                "id": 3,
                "x": 1000,
                "y": 0,
                "width": 1920,
                "height": 1080,
                "scale": 2,
            }
            left = {
                "address": "0xleft",
                "monitor": 3,
                "workspace": {"name": "ws-e2e"},
                "pid": 11,
                "at": [1000, 40],
                "size": [476, 420],
                "floating": True,
            }
            right = {
                "address": "0xright",
                "monitor": 3,
                "workspace": {"name": "ws-e2e"},
                "pid": 12,
                "at": [1484, 40],
                "size": [476, 420],
                "floating": True,
            }

            def query(name: str, **_: object) -> object:
                if name == "monitors":
                    return [monitor]
                if name == "clients":
                    return [left, right]
                return []

            with mock.patch.object(harness, "query", side_effect=query), mock.patch.object(
                harness, "set_floating"
            ), mock.patch.object(harness, "move_resize") as move_resize, mock.patch.object(
                harness, "token_in_environ", return_value=True
            ):
                detail = harness.tile_side_by_side("0xleft", "0xright")
            self.assertEqual(detail["left"]["address"], "0xleft")
            self.assertEqual(detail["right"]["address"], "0xright")
            self.assertEqual(move_resize.call_count, 2)
            left_call, right_call = move_resize.call_args_list
            self.assertEqual(left_call.args[0], "0xleft")
            self.assertEqual(right_call.args[0], "0xright")
            self.assertLess(left_call.args[1], right_call.args[1])
            self.assertTrue(any(check["name"] == "workflow-tiled" for check in harness.evidence["checks"]))

    def test_dispatch_exec_exports_isolation_env(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner = FakeRunner([completed("ok")])
            harness = HARNESS.HandsfreeHarness(args(Path(directory)), runner)
            harness.output = "MON"
            harness.workspace = "WS"
            harness.dispatch_exec(["true"])
            lua = runner.commands[0][2]
            self.assertIn("OMP_E2E_MONITOR=MON", lua)
            self.assertIn("OMP_E2E_WORKSPACE=WS", lua)
            self.assertIn(f"OMP_HANDSFREE_E2E_TOKEN={harness.token}", lua)
            self.assertIn('monitor = "MON"', lua)
            self.assertIn('workspace = "name:WS"', lua)
            self.assertIn("no_initial_focus = true", lua)


if __name__ == "__main__":
    unittest.main()
