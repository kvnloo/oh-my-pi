from __future__ import annotations

import json
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol


class CommandRunner(Protocol):
    def __call__(
        self,
        command: list[str],
        *,
        check: bool,
        capture_output: bool,
        text: bool,
        timeout: float,
    ) -> subprocess.CompletedProcess[str]: ...


@dataclass(frozen=True, slots=True)
class HyprlandContext:
    workspace: str
    app_class: str
    title: str

    @property
    def label(self) -> str:
        app = self.app_class or "desktop"
        workspace = self.workspace or "?"
        return f"Workspace {workspace} · {app}"


class HyprctlError(RuntimeError):
    pass


def _read_json(command: str, runner: CommandRunner) -> dict[str, object]:
    try:
        result = runner(
            ["hyprctl", "-j", command],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
        payload = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise HyprctlError(f"hyprctl {command} failed: {error}") from error
    if not isinstance(payload, dict):
        raise HyprctlError(f"hyprctl {command} returned a non-object")
    return payload


def read_context(runner: CommandRunner = subprocess.run) -> HyprlandContext:
    workspace = _read_json("activeworkspace", runner)
    window = _read_json("activewindow", runner)
    return HyprlandContext(
        workspace=str(workspace.get("name") or workspace.get("id") or ""),
        app_class=str(window.get("class") or ""),
        title=str(window.get("title") or ""),
    )


class ContextMonitor:
    def __init__(
        self,
        on_context: Callable[[HyprlandContext], None],
        on_error: Callable[[str], None],
        *,
        interval: float = 0.75,
        reader: Callable[[], HyprlandContext] = read_context,
    ) -> None:
        self._on_context = on_context
        self._on_error = on_error
        self._interval = interval
        self._reader = reader
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="omp-hud-hyprctl", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _run(self) -> None:
        previous: HyprlandContext | None = None
        previous_error: str | None = None
        while not self._stop.is_set():
            try:
                context = self._reader()
                if context != previous:
                    self._on_context(context)
                    previous = context
                previous_error = None
            except HyprctlError as error:
                message = str(error)
                if message != previous_error:
                    self._on_error(message)
                    previous = None
                    previous_error = message
            self._stop.wait(self._interval)
