from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
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

_CONTEXT_EVENTS = frozenset(
    {
        "activewindow",
        "activewindowv2",
        "focusedmon",
        "workspace",
        "workspacev2",
    }
)
_WINDOW_EVENTS = frozenset(
    {
        "changefloatingmode",
        "closewindow",
        "movewindow",
        "movewindowv2",
        "openwindow",
        "windowtitle",
        "windowtitlev2",
    }
)


def event_socket_path(
    env: Mapping[str, str] = os.environ,
    *,
    uid: int | None = None,
) -> str | None:
    signature = env.get("HYPRLAND_INSTANCE_SIGNATURE")
    if not signature:
        return None
    runtime_dir = env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid if uid is not None else os.getuid()}"
    candidates = (
        Path(runtime_dir) / "hypr" / signature / ".socket2.sock",
        Path("/tmp/hypr") / signature / ".socket2.sock",
    )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return str(candidates[0])


def _connect_event_socket(path: str) -> socket.socket:
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        connection.connect(path)
        connection.settimeout(0.25)
    except OSError:
        connection.close()
        raise
    return connection


def _dispatch(
    arguments: list[str],
    runner: CommandRunner,
) -> str:
    try:
        result = runner(
            ["hyprctl", *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=2.0,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise HyprctlError(f"hyprctl {' '.join(arguments)} failed: {error}") from error
    return result.stdout.strip()


def _dispatch_overlay_action(
    address: str,
    action: str,
    runner: CommandRunner,
) -> None:
    selector = f"address:{address}"
    legacy = [action, selector]
    lua_action = "float" if action == "setfloating" else "pin"
    lua = [
        f'hl.dsp.window.{lua_action}({{ action = "enable", window = "{selector}" }})'
    ]
    for arguments in (["dispatch", *legacy], ["dispatch", *lua]):
        reply = _dispatch(arguments, runner)
        if reply == "ok":
            return
        if not (
            reply.startswith("Invalid dispatcher")
            or reply.startswith("error:")
        ):
            break
    raise HyprctlError(f"hyprctl dispatch {action} failed")

def _find_hud_client(clients: list[object]) -> dict[str, object] | None:
    mapped = [
        raw
        for raw in clients
        if isinstance(raw, dict)
        and raw.get("mapped") is not False
        and raw.get("address")
    ]
    titled = next(
        (raw for raw in mapped if str(raw.get("title") or "") == "OMP HUD"),
        None,
    )
    if titled is not None:
        return titled
    return next(
        (
            raw
            for raw in mapped
            if raw.get("class") == "omp-hud"
            or raw.get("initialClass") == "omp-hud"
        ),
        None,
    )


def _position_hud(
    address: str,
    width: int,
    height: int,
    bottom_margin: int,
    runner: CommandRunner,
) -> None:
    monitors = _read_json_array("monitors", runner)
    monitor = next(
        (
            raw
            for raw in monitors
            if isinstance(raw, dict) and raw.get("focused") is True
        ),
        None,
    )
    if monitor is None:
        monitor = next((raw for raw in monitors if isinstance(raw, dict)), None)
    if monitor is None:
        raise HyprctlError("Hyprland did not expose a monitor for the OMP HUD")
    scale = float(monitor.get("scale") or 1)
    monitor_width = round(float(monitor.get("width") or 0) / scale)
    monitor_height = round(float(monitor.get("height") or 0) / scale)
    monitor_x = round(float(monitor.get("x") or 0))
    monitor_y = round(float(monitor.get("y") or 0))
    x = monitor_x + max(0, (monitor_width - width) // 2)
    y = monitor_y + max(0, monitor_height - height - bottom_margin)
    reply = _dispatch(
        [
            "dispatch",
            "movewindowpixel",
            f"exact {x} {y},address:{address}",
        ],
        runner,
    )
    if reply != "ok":
        raise HyprctlError("hyprctl dispatch movewindowpixel failed")




def promote_hud_overlay(
    runner: CommandRunner = subprocess.run,
    *,
    attempts: int = 8,
    delay: float = 0.05,
    width: int | None = None,
    height: int | None = None,
    bottom_margin: int = 16,
    env: Mapping[str, str] = os.environ,
) -> None:
    if not env.get("HYPRLAND_INSTANCE_SIGNATURE"):
        raise HyprctlError("Hyprland is unavailable")
    for attempt in range(attempts):
        clients = _read_json_array("clients", runner)
        client = _find_hud_client(clients)
        if client is None:
            if attempt + 1 < attempts:
                threading.Event().wait(delay)
            continue
        address = str(client["address"])
        if not address.lower().startswith("0x"):
            address = f"0x{address}"
        if client.get("floating") is not True:
            _dispatch_overlay_action(address, "setfloating", runner)
        if client.get("pinned") is not True:
            _dispatch_overlay_action(address, "pin", runner)
        if width is not None and height is not None:
            _position_hud(address, width, height, bottom_margin, runner)
        verified = next(
            (
                raw
                for raw in _read_json_array("clients", runner)
                if isinstance(raw, dict)
                and (
                    str(raw.get("address") or "").lower() == address.lower()
                    or f"0x{str(raw.get('address') or '').lower()}"
                    == address.lower()
                )
            ),
            None,
        )
        if (
            verified is not None
            and verified.get("floating") is True
            and verified.get("pinned") is True
        ):
            return
        if attempt + 1 < attempts:
            threading.Event().wait(delay)
    raise HyprctlError("Hyprland did not expose a floating, pinned OMP HUD")


EventSocketConnector = Callable[[str], socket.socket]




class ContextMonitor:
    def __init__(
        self,
        on_context: Callable[[HyprlandContext], None],
        on_error: Callable[[str], None],
        *,
        interval: float = 5.0,
        reader: Callable[[], HyprlandContext] = read_context,
        on_windows: Callable[[tuple[HyprlandWindow, ...]], None] | None = None,
        window_reader: Callable[[], tuple[HyprlandWindow, ...]] = read_windows,
        socket_path: Callable[[], str | None] = event_socket_path,
        socket_connector: EventSocketConnector = _connect_event_socket,
    ) -> None:
        self._on_context = on_context
        self._on_error = on_error
        self._interval = interval
        self._reader = reader
        self._on_windows = on_windows
        self._window_reader = window_reader
        self._socket_path = socket_path
        self._socket_connector = socket_connector
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._connection: socket.socket | None = None
        self._previous: HyprlandContext | None = None
        self._previous_windows: tuple[HyprlandWindow, ...] | None = None
        self._previous_error: str | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run,
            name="omp-hud-hyprland",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        connection = self._connection
        if connection is not None:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _refresh(self, *, context: bool = True, windows: bool = True) -> None:
        try:
            if context:
                current = self._reader()
                if current != self._previous:
                    self._on_context(current)
                    self._previous = current
            if windows and self._on_windows is not None:
                current_windows = self._window_reader()
                if current_windows != self._previous_windows:
                    self._on_windows(current_windows)
                    self._previous_windows = current_windows
            self._previous_error = None
        except HyprctlError as error:
            message = str(error)
            if message != self._previous_error:
                self._on_error(message)
                self._previous = None
                self._previous_windows = None
                self._previous_error = message

    def _listen(self, path: str) -> None:
        connection = self._socket_connector(path)
        self._connection = connection
        pending = b""
        try:
            self._refresh()
            while not self._stop.is_set():
                try:
                    chunk = connection.recv(4096)
                except TimeoutError:
                    continue
                if not chunk:
                    raise OSError("Hyprland event socket closed")
                pending += chunk
                lines = pending.split(b"\n")
                pending = lines.pop()
                names = {
                    line.partition(b">>")[0].decode(errors="replace")
                    for line in lines
                    if b">>" in line
                }
                refresh_context = bool(names & _CONTEXT_EVENTS)
                refresh_windows = bool(names & _WINDOW_EVENTS)
                if refresh_context or refresh_windows:
                    self._refresh(
                        context=refresh_context,
                        windows=refresh_windows,
                    )
        finally:
            self._connection = None
            connection.close()

    def _run(self) -> None:
        while not self._stop.is_set():
            path = self._socket_path()
            if path is not None:
                try:
                    self._listen(path)
                    continue
                except OSError:
                    if self._stop.is_set():
                        return
            self._refresh()
            self._stop.wait(self._interval)
