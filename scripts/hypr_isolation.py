#!/usr/bin/env python3
"""Hyprland UI test isolation (hyprland-ui-testing skill).

Launch on a headless output + silent named workspace with noinitialfocus.
Never move the user's windows; verify active workspace/focus stay unchanged.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import time
from dataclasses import dataclass
from typing import Any, Callable


class IsolationError(RuntimeError):
    pass


Runner = Callable[[list[str], float], subprocess.CompletedProcess[str]]


def default_runner(argv: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def hypr_json(name: str, *, runner: Runner = default_runner, timeout: float = 5.0) -> Any:
    result = runner(["hyprctl", "-j", name], timeout)
    if result.returncode:
        raise IsolationError(
            f"hyprctl -j {name} failed ({result.returncode}): {result.stderr.strip()}"
        )
    return json.loads(result.stdout)


@dataclass(frozen=True)
class Baseline:
    workspace_id: int
    workspace_name: str
    focus_address: str | None

    @classmethod
    def capture(cls, *, runner: Runner = default_runner, timeout: float = 5.0) -> Baseline:
        ws = hypr_json("activeworkspace", runner=runner, timeout=timeout)
        aw = hypr_json("activewindow", runner=runner, timeout=timeout)
        return cls(
            workspace_id=int(ws.get("id") or 0),
            workspace_name=str(ws.get("name") or ""),
            focus_address=aw.get("address") if isinstance(aw, dict) else None,
        )

    def matches_current(self, *, runner: Runner = default_runner, timeout: float = 5.0) -> bool:
        cur = self.capture(runner=runner, timeout=timeout)
        return (
            cur.workspace_id == self.workspace_id
            and cur.focus_address == self.focus_address
        )

    def restore_focus(self, *, runner: Runner = default_runner, timeout: float = 5.0) -> None:
        """Only when we stole focus during an isolated launch."""
        runner(["hyprctl", "dispatch", "workspace", str(self.workspace_id)], timeout)
        if self.focus_address:
            runner(
                [
                    "hyprctl",
                    "dispatch",
                    "focuswindow",
                    f"address:{self.focus_address}",
                ],
                timeout,
            )
        time.sleep(0.05)


def assert_user_unchanged(
    baseline: Baseline,
    *,
    runner: Runner = default_runner,
    timeout: float = 5.0,
    label: str = "user state",
) -> None:
    if not baseline.matches_current(runner=runner, timeout=timeout):
        cur = Baseline.capture(runner=runner, timeout=timeout)
        raise IsolationError(
            f"{label}: workspace/focus changed "
            f"(was ws {baseline.workspace_id} focus {baseline.focus_address}, "
            f"now ws {cur.workspace_id} focus {cur.focus_address})"
        )


def dispatch_exec_isolated(
    command: list[str],
    *,
    output: str,
    workspace: str,
    env_prefix: str = "",
    runner: Runner = default_runner,
    timeout: float = 10.0,
    baseline: Baseline | None = None,
) -> None:
    """Launch once on headless output; recover focus if Hyprland steals it."""
    shell = f"{env_prefix}{shlex.join(command)}".strip()
    legacy = (
        f"[workspace name:{workspace} silent; monitor {output}; noinitialfocus] "
        f"{shell}"
    )
    result = runner(["hyprctl", "dispatch", "exec", legacy], timeout)
    reply = (result.stdout or result.stderr or "").strip()
    if reply not in {"", "ok"}:
        expression = (
            f"hl.dsp.exec_cmd({json.dumps(shell)}, "
            f'{{ workspace = "name:{workspace}", '
            f'monitor = "{output}", no_initial_focus = true }})'
        )
        result = runner(["hyprctl", "dispatch", expression], timeout)
        reply = (result.stdout or result.stderr or "").strip()
        if reply not in {"", "ok"}:
            raise IsolationError(f"exec rejected: {reply or result.stderr.strip()}")
    if baseline is not None and not baseline.matches_current(runner=runner, timeout=2.0):
        baseline.restore_focus(runner=runner, timeout=timeout)
        if not baseline.matches_current(runner=runner, timeout=2.0):
            raise IsolationError(
                "isolated exec stole focus and could not restore user baseline"
            )


def create_headless_output(
    name: str, *, runner: Runner = default_runner, timeout: float = 10.0
) -> int:
    result = runner(["hyprctl", "output", "create", "headless", name], timeout)
    if result.returncode:
        raise IsolationError(f"output create failed: {result.stderr.strip()}")
    monitors = hypr_json("monitors", runner=runner, timeout=timeout)
    matches = [m for m in monitors if m.get("name") == name]
    if len(matches) != 1 or not isinstance(matches[0].get("id"), int):
        raise IsolationError(f"headless output {name} not found after create")
    return int(matches[0]["id"])


def remove_headless_output(
    name: str, *, runner: Runner = default_runner, timeout: float = 10.0
) -> None:
    runner(["hyprctl", "output", "remove", name], timeout)


def clients_on_monitor(
    monitor_id: int, *, runner: Runner = default_runner, timeout: float = 5.0
) -> list[dict[str, Any]]:
    clients = hypr_json("clients", runner=runner, timeout=timeout)
    if not isinstance(clients, list):
        return []
    return [
        c
        for c in clients
        if isinstance(c, dict) and c.get("monitor") == monitor_id and c.get("address")
    ]


def require_live_ws_allowed() -> None:
    import os

    if os.environ.get("OMP_ALLOW_LIVE_WS") != "1":
        raise IsolationError(
            "Refusing live-workspace Hyprland mutations. "
            "Use --headless (default) or set OMP_ALLOW_LIVE_WS=1 to opt in."
        )


def safe_dispatch(
    argv: list[str],
    baseline: Baseline,
    *,
    runner: Runner = default_runner,
    timeout: float = 5.0,
) -> None:
    """Run a hyprctl dispatch; undo focus steal immediately if Hyprland grabs it."""
    result = runner(argv, timeout)
    reply = (result.stdout or result.stderr or "").strip()
    if result.returncode and reply not in {"", "ok"}:
        raise IsolationError(f"{argv}: {reply or result.stderr.strip()}")
    if not baseline.matches_current(runner=runner, timeout=1.0):
        baseline.restore_focus(runner=runner, timeout=timeout)
        if not baseline.matches_current(runner=runner, timeout=1.0):
            raise IsolationError("dispatch stole focus and could not restore baseline")
