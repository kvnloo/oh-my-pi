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
    address: str = ""

    @property
    def label(self) -> str:
        app = self.app_class or "desktop"
        workspace = self.workspace or "?"
        return f"Workspace {workspace} · {app}"


@dataclass(frozen=True, slots=True)
class HyprlandWindow:
    address: str
    workspace: str
    app_class: str
    title: str
    pid: int | None = None

    @property
    def key(self) -> str:
        return self.address or f"{self.workspace}\0{self.app_class}\0{self.title}"

    @property
    def label(self) -> str:
        app = self.app_class or "Unknown app"
        return f"{app} — {self.title}" if self.title else app

    def as_context(self) -> HyprlandContext:
        return HyprlandContext(
            workspace=self.workspace,
            app_class=self.app_class,
            title=self.title,
            address=self.address,
        )

class HyprctlError(RuntimeError):
    pass


def _run_json(command: str, runner: CommandRunner) -> object:
    try:
        result = runner(
            ["hyprctl", "-j", command],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise HyprctlError(f"hyprctl {command} failed: {error}") from error


def _read_json(command: str, runner: CommandRunner) -> dict[str, object]:
    payload = _run_json(command, runner)
    if not isinstance(payload, dict):
        raise HyprctlError(f"hyprctl {command} returned a non-object")
    return payload


def _read_json_array(command: str, runner: CommandRunner) -> list[object]:
    payload = _run_json(command, runner)
    if not isinstance(payload, list):
        raise HyprctlError(f"hyprctl {command} returned a non-array")
    return payload


def read_context(runner: CommandRunner = subprocess.run) -> HyprlandContext:
    workspace = _read_json("activeworkspace", runner)
    window = _read_json("activewindow", runner)
    return HyprlandContext(
        workspace=str(workspace.get("name") or workspace.get("id") or ""),
        app_class=str(window.get("class") or ""),
        title=str(window.get("title") or ""),
        address=str(window.get("address") or ""),
    )


def read_windows(runner: CommandRunner = subprocess.run) -> tuple[HyprlandWindow, ...]:
    clients = _read_json_array("clients", runner)
    windows: list[HyprlandWindow] = []
    for raw_client in clients:
        if not isinstance(raw_client, dict) or raw_client.get("mapped") is False:
            continue
        workspace_data = raw_client.get("workspace")
        if isinstance(workspace_data, dict):
            workspace = str(
                workspace_data.get("name") or workspace_data.get("id") or ""
            )
        else:
            workspace = str(workspace_data or "")
        raw_pid = raw_client.get("pid")
        pid = raw_pid if isinstance(raw_pid, int) else None
        window = HyprlandWindow(
            address=str(raw_client.get("address") or ""),
            workspace=workspace,
            app_class=str(raw_client.get("class") or ""),
            title=str(raw_client.get("title") or ""),
            pid=pid,
        )
        if window.address or window.app_class or window.title:
            windows.append(window)
    return tuple(windows)


class ContextMonitor:
    def __init__(
        self,
        on_context: Callable[[HyprlandContext], None],
        on_error: Callable[[str], None],
        *,
        interval: float = 0.75,
        reader: Callable[[], HyprlandContext] = read_context,
        on_windows: Callable[[tuple[HyprlandWindow, ...]], None] | None = None,
        window_reader: Callable[[], tuple[HyprlandWindow, ...]] = read_windows,
    ) -> None:
        self._on_context = on_context
        self._on_error = on_error
        self._interval = interval
        self._reader = reader
        self._on_windows = on_windows
        self._window_reader = window_reader
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
        previous_windows: tuple[HyprlandWindow, ...] | None = None
        previous_error: str | None = None
        while not self._stop.is_set():
            try:
                context = self._reader()
                windows = (
                    self._window_reader() if self._on_windows is not None else None
                )
                if context != previous:
                    self._on_context(context)
                    previous = context
                if (
                    windows is not None
                    and windows != previous_windows
                    and self._on_windows is not None
                ):
                    self._on_windows(windows)
                    previous_windows = windows
                previous_error = None
            except HyprctlError as error:
                message = str(error)
                if message != previous_error:
                    self._on_error(message)
                    previous = None
                    previous_windows = None
                    previous_error = message
            self._stop.wait(self._interval)
