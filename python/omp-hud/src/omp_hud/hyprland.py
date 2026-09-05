from __future__ import annotations

import contextlib
import json
import os
import socket
import subprocess
import threading
from collections.abc import Callable, Iterator, Mapping
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
        # Membership / identity only. Geometry events (movewindow*) fire on every
        # Stage rotate and must NOT re-query clients — that fights the layout batch
        # and made Super+H/L feel 250–500ms + jagged.
        "closewindow",
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
    # Hyprland 0.55+ with a Lua config evaluates `dispatch` as Lua, so the
    # classic `setfloating`/`pin` strings fail there while `hl.dsp.*` fails on
    # hyprlang sessions. Grammar is only discoverable by trying: lua first
    # (this session speaks Lua), legacy as fallback.
    selector = f"address:{address}"
    if action == "setfloating":
        lua_action = "float"
        mode = "enable"
        legacy = ["setfloating", selector]
    elif action == "pin":
        lua_action = "pin"
        mode = "enable"
        legacy = ["pin", selector]
    elif action == "unpin":
        lua_action = "pin"
        mode = "disable"
        legacy = ["pin", selector]
    else:
        raise HyprctlError(f"unsupported overlay action {action!r}")
    lua = [
        f'hl.dsp.window.{lua_action}({{ action = "{mode}", window = "{selector}" }})'
    ]
    for arguments in (["dispatch", *lua], ["dispatch", *legacy]):
        reply = _dispatch(arguments, runner)
        if reply == "ok":
            return
        if not (
            reply.startswith("Invalid dispatcher")
            or reply.startswith("error:")
            or "attempt to call a nil value" in reply
        ):
            break
    raise HyprctlError(f"hyprctl dispatch {action} failed")


def _find_hud_client(
    clients: list[object],
    *,
    own_pid: int | None = None,
) -> dict[str, object] | None:
    # PID match is bulletproof: the app passes os.getpid(), and hyprctl
    # reports the client pid. Title/class matching is fallback only — the
    # title gains a " — ..." suffix on UI requests and the class is the
    # interpreter name (__main__.py), so neither is stable.
    if own_pid is None:
        own_pid = os.getpid()
    mapped = [
        raw
        for raw in clients
        if isinstance(raw, dict)
        and raw.get("mapped") is not False
        and raw.get("address")
    ]
    own = next(
        (raw for raw in mapped if raw.get("pid") == own_pid),
        None,
    )
    if own is not None:
        return own
    titled = next(
        (
            raw
            for raw in mapped
            if str(raw.get("title") or "").startswith(("OMP Handsfree Mode", "OMP HUD"))
        ),
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


def _calculate_hud_position(
    monitor: Mapping[str, object],
    width: int,
    height: int,
    bottom_margin: int,
) -> tuple[int, int]:
    scale = float(monitor.get("scale") or 1)
    if scale <= 0:
        raise HyprctlError("HUD monitor scale must be positive")

    monitor_width = round(float(monitor.get("width") or 0) / scale)
    monitor_height = round(float(monitor.get("height") or 0) / scale)
    if width <= 0 or height <= 0 or bottom_margin < 0:
        raise HyprctlError("HUD dimensions and bottom margin must be valid")
    if width > monitor_width or height + bottom_margin > monitor_height:
        raise HyprctlError(
            "HUD dimensions exceed the mapped monitor's logical bounds"
        )

    monitor_x = round(float(monitor.get("x") or 0))
    monitor_y = round(float(monitor.get("y") or 0))
    return (
        monitor_x + (monitor_width - width) // 2,
        monitor_y + monitor_height - height - bottom_margin,
    )


def _hud_monitor(
    client_monitor: object | None,
    runner: CommandRunner,
) -> Mapping[str, object]:
    if client_monitor is None:
        raise HyprctlError("Hyprland did not expose the HUD client's mapped monitor")
    monitor = next(
        (
            raw
            for raw in _read_json_array("monitors", runner)
            if isinstance(raw, dict) and raw.get("id") == client_monitor
        ),
        None,
    )
    if monitor is None:
        raise HyprctlError(
            f"Hyprland did not expose HUD monitor {client_monitor!r}"
        )
    return monitor


def _dispatch_hud_resize(
    address: str,
    width: int,
    height: int,
    runner: CommandRunner,
) -> None:
    selector = f"address:{address}"
    attempts = (
        [f'hl.dsp.window.resize({{ x = {width}, y = {height}, window = "{selector}" }})'],
        ["resizewindowpixel", f"exact {width} {height},{selector}"],
    )
    for arguments in attempts:
        reply = _dispatch(["dispatch", *arguments], runner)
        if reply == "ok":
            return
        if not (
            reply.startswith("Invalid dispatcher")
            or reply.startswith("error:")
            or "attempt to call a nil value" in reply
        ):
            break
    raise HyprctlError("hyprctl dispatch resizewindowpixel failed")


def _client_at_address(
    address: str,
    runner: CommandRunner,
) -> dict[str, object] | None:
    return next(
        (
            raw
            for raw in _read_json_array("clients", runner)
            if isinstance(raw, dict)
            and (
                str(raw.get("address") or "").lower() == address.lower()
                or f"0x{str(raw.get('address') or '').lower()}" == address.lower()
            )
        ),
        None,
    )


def _position_hud(
    address: str,
    client_monitor: object | None,
    width: int,
    height: int,
    bottom_margin: int,
    runner: CommandRunner,
) -> tuple[int, int, object | None]:
    monitor = _hud_monitor(client_monitor, runner)

    x, y = _calculate_hud_position(monitor, width, height, bottom_margin)
    selector = f"address:{address}"
    attempts = (
        [f'hl.dsp.window.move({{ x = {x}, y = {y}, window = "{selector}" }})'],
        ["movewindowpixel", f"exact {x} {y},{selector}"],
    )
    for arguments in attempts:
        reply = _dispatch(["dispatch", *arguments], runner)
        if reply == "ok":
            return x, y, monitor.get("id")
        if not (
            reply.startswith("Invalid dispatcher")
            or reply.startswith("error:")
            or "attempt to call a nil value" in reply
        ):
            break
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
    # Pin is optional. Default is float-only bottom placement: pin fails or
    # detaches clients on some Hyprland setups (monitor -1 / all-workspace
    # bleed). Opt in with OMP_HUD_PIN=1. Isolation tests force unpin via
    # OMP_HUD_E2E_NO_PIN.
    no_pin = env.get("OMP_HUD_E2E_NO_PIN", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    want_pin = (not no_pin) and env.get("OMP_HUD_PIN", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    require_pin = want_pin
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
        if require_pin:
            if client.get("pinned") is not True:
                _dispatch_overlay_action(address, "pin", runner)
        elif no_pin and client.get("pinned") is True:
            _dispatch_overlay_action(address, "unpin", runner)

        expected_position: tuple[int, int, object | None] | None = None
        expected_size: tuple[int, int] | None = None
        if width is not None and height is not None:
            monitor = _hud_monitor(client.get("monitor"), runner)
            size = client.get("size")
            if not (
                isinstance(size, list)
                and len(size) >= 2
                and isinstance(size[0], int)
                and not isinstance(size[0], bool)
                and isinstance(size[1], int)
                and not isinstance(size[1], bool)
            ):
                if attempt + 1 < attempts:
                    threading.Event().wait(delay)
                continue
            actual_width, actual_height = size[:2]
            scale = float(monitor.get("scale") or 1)
            logical_width = round(float(monitor.get("width") or 0) / scale)
            logical_height = round(float(monitor.get("height") or 0) / scale)
            max_width = logical_width - 32
            fitted_width = min(actual_width, width, max_width)
            fitted_height = height
            if fitted_width <= 0:
                raise HyprctlError("HUD monitor has no usable logical width")
            if fitted_height <= 0:
                raise HyprctlError("HUD height must be positive")
            if fitted_height + bottom_margin > logical_height:
                raise HyprctlError(
                    "HUD dimensions exceed the mapped monitor's logical bounds"
                )
            expected_size = (fitted_width, fitted_height)
            if actual_width != fitted_width or actual_height != fitted_height:
                _dispatch_hud_resize(
                    address, fitted_width, fitted_height, runner
                )
                client = _client_at_address(address, runner) or client
                resized = client.get("size")
                if resized != [fitted_width, fitted_height]:
                    if attempt + 1 < attempts:
                        threading.Event().wait(delay)
                    continue
            expected_position = _position_hud(
                address,
                client.get("monitor"),
                fitted_width,
                fitted_height,
                bottom_margin,
                runner,
            )
        verified = _client_at_address(address, runner)
        placement_verified = expected_position is None or (
            verified is not None
            and verified.get("monitor") == expected_position[2]
            and verified.get("at") == [expected_position[0], expected_position[1]]
            and expected_size is not None
            and verified.get("size") == list(expected_size)
        )
        if require_pin:
            pinned_ok = (
                verified is not None and verified.get("pinned") is True
            )
        elif no_pin:
            pinned_ok = (
                verified is not None and verified.get("pinned") is not True
            )
        else:
            # Default MVP: float + place; pin state is ignored.
            pinned_ok = True

        if (
            verified is not None
            and verified.get("floating") is True
            and pinned_ok
            and placement_verified
        ):
            return
        if attempt + 1 < attempts:
            threading.Event().wait(delay)
    if require_pin:
        raise HyprctlError("Hyprland did not expose a floating, pinned OMP HUD")
    if no_pin:
        raise HyprctlError("Hyprland did not expose a floating, unpinned OMP HUD")
    raise HyprctlError("Hyprland did not expose a floating OMP HUD")

# --- Felix-style handsfree carousel (HUD-owned, Hyprland-direct) -------------

CAROUSEL_GAP_OUT = 40
CAROUSEL_GAP_BETWEEN = 28
CAROUSEL_BOTTOM_SAFE = 86
CAROUSEL_ACTIVE_WIDTH_FRAC = 0.72
CAROUSEL_ACTIVE_HEIGHT_FRAC = 0.82
CAROUSEL_PEEK_VISIBLE_FRAC = 0.14


@dataclass(frozen=True, slots=True)
class CarouselMonitor:
    id: int
    x: int
    y: int
    width: int
    height: int
    reserved: tuple[int, int, int, int]  # left, top, right, bottom (logical)


@dataclass(frozen=True, slots=True)
class CarouselSlot:
    address: str
    x: int
    y: int
    width: int
    height: int
    role: str  # active | left | right


@dataclass(frozen=True, slots=True)
class ClientGeometryBaseline:
    address: str
    workspace: str
    floating: bool
    x: int
    y: int
    width: int
    height: int


def _logical_monitor(raw: Mapping[str, object]) -> CarouselMonitor:
    scale = float(raw.get("scale") or 1) or 1.0
    reserved_raw = raw.get("reserved")
    if isinstance(reserved_raw, list) and len(reserved_raw) >= 4:
        reserved = tuple(round(float(reserved_raw[i]) / scale) for i in range(4))
    else:
        reserved = (0, 0, 0, 0)
    return CarouselMonitor(
        id=int(raw.get("id") or 0),
        x=int(raw.get("x") or 0),
        y=int(raw.get("y") or 0),
        width=round(float(raw.get("width") or 0) / scale),
        height=round(float(raw.get("height") or 0) / scale),
        reserved=(int(reserved[0]), int(reserved[1]), int(reserved[2]), int(reserved[3])),
    )




def _dispatch_window_action(
    address: str,
    *,
    lua: list[str],
    legacy: list[str],
    runner: CommandRunner,
) -> None:
    selector = address if address.startswith("address:") else f"address:{address}"
    # lua templates already include selector; legacy may need it baked in.
    last = ""
    for arguments in (lua, legacy):
        if not arguments:
            continue
        reply = _dispatch(["dispatch", *arguments], runner)
        last = reply
        if reply == "ok":
            return
        if not (
            reply.startswith("Invalid dispatcher")
            or reply.startswith("error:")
            or "attempt to call a nil value" in reply
        ):
            break
    raise HyprctlError(f"hyprctl dispatch failed for {selector}: {last or 'no response'}")


def _batch_lua_dispatches(runner: CommandRunner, expressions: list[str]) -> None:
    """Run many hl.dispatch(...) calls in one hyprctl eval (one IPC round-trip)."""
    if not expressions:
        return
    code = "\n".join(expressions)
    with _layout_busy():
        reply = _dispatch(["eval", code], runner)
        if reply in {"ok", ""}:
            return
        # Batch rejected — fall back one-by-one so partial layouts still progress.
        last = reply
        for expression in expressions:
            one = _dispatch(["eval", expression], runner)
            if one not in {"ok", ""}:
                last = one
                if not (
                    one.startswith("Invalid dispatcher")
                    or one.startswith("error:")
                    or "attempt to call a nil value" in one
                ):
                    raise HyprctlError(f"hyprctl eval failed: {one}")
        if last not in {"ok", ""}:
            raise HyprctlError(f"hyprctl eval batch failed: {last}")


_LAYOUT_BUSY = threading.Event()


@contextlib.contextmanager
def _layout_busy() -> Iterator[None]:
    """While Stage is applying geometry, ContextMonitor must not hyprctl-poll."""
    _LAYOUT_BUSY.set()
    try:
        yield
    finally:
        _LAYOUT_BUSY.clear()



def _lua_float(address: str, floating: bool) -> str:
    mode = "enable" if floating else "disable"
    return (
        f'hl.dispatch(hl.dsp.window.float({{ action = "{mode}", '
        f'window = "address:{address}" }}))'
    )


def _lua_workspace(address: str, workspace: str) -> str:
    ws = workspace.replace("\\", "\\\\").replace('"', '\\"')
    return (
        f'hl.dispatch(hl.dsp.window.move({{ workspace = "{ws}", '
        f'window = "address:{address}" }}))'
    )


def _lua_focus(address: str) -> str:
    return f'hl.dispatch(hl.dsp.focus({{ window = "address:{address}" }}))'


def _lua_resize(address: str, width: int, height: int) -> str:
    return (
        f'hl.dispatch(hl.dsp.window.resize({{ x = {int(width)}, y = {int(height)}, '
        f'window = "address:{address}" }}))'
    )


def _lua_move(address: str, x: int, y: int) -> str:
    return (
        f'hl.dispatch(hl.dsp.window.move({{ x = {int(x)}, y = {int(y)}, '
        f'window = "address:{address}" }}))'
    )


def _set_windows_move_animation(
    runner: CommandRunner, *, enabled: bool, speed: float = 2.0
) -> None:
    """Toggle Hyprland windowsMove animation (Lua configs). Best-effort."""
    flag = "true" if enabled else "false"
    code = (
        f'hl.animation({{ leaf = "windowsMove", enabled = {flag}, '
        f'speed = {speed}, bezier = "default" }})'
    )
    try:
        _dispatch(["eval", code], runner)
    except HyprctlError:
        pass


def _set_window_floating(address: str, floating: bool, runner: CommandRunner) -> None:
    selector = f"address:{address}"
    mode = "enable" if floating else "disable"
    _dispatch_window_action(
        address,
        lua=[f'hl.dsp.window.float({{ action = "{mode}", window = "{selector}" }})'],
        legacy=["setfloating" if floating else "settiled", selector],
        runner=runner,
    )


def _move_window_workspace(address: str, workspace: str, runner: CommandRunner) -> None:
    selector = f"address:{address}"
    ws = workspace.replace("\\", "\\\\").replace('"', '\\"')
    _dispatch_window_action(
        address,
        lua=[f'hl.dsp.window.move({{ workspace = "{ws}", window = "{selector}" }})'],
        legacy=["movetoworkspacesilent", f"{workspace},{selector}"],
        runner=runner,
    )


def _focus_window(address: str, runner: CommandRunner) -> None:
    selector = f"address:{address}"
    _dispatch_window_action(
        address,
        lua=[f'hl.dsp.focus({{ window = "{selector}" }})'],
        legacy=["focuswindow", selector],
        runner=runner,
    )


def _resize_window(address: str, width: int, height: int, runner: CommandRunner) -> None:
    selector = f"address:{address}"
    w, h = max(1, int(width)), max(1, int(height))
    _dispatch_window_action(
        address,
        lua=[f'hl.dsp.window.resize({{ x = {w}, y = {h}, window = "{selector}" }})'],
        legacy=["resizewindowpixel", f"exact {w} {h},{selector}"],
        runner=runner,
    )


def _move_window_pixel(address: str, x: int, y: int, runner: CommandRunner) -> None:
    selector = f"address:{address}"
    px, py = int(x), int(y)
    _dispatch_window_action(
        address,
        lua=[f'hl.dsp.window.move({{ x = {px}, y = {py}, window = "{selector}" }})'],
        legacy=["movewindowpixel", f"exact {px} {py},{selector}"],
        runner=runner,
    )


def _read_client_baselines(
    addresses: list[str],
    runner: CommandRunner,
) -> dict[str, ClientGeometryBaseline]:
    wanted = {address.lower() for address in addresses}
    baselines: dict[str, ClientGeometryBaseline] = {}
    for raw in _read_json_array("clients", runner):
        if not isinstance(raw, dict) or raw.get("mapped") is False:
            continue
        address = str(raw.get("address") or "").lower()
        if not address.startswith("0x"):
            address = f"0x{address}"
        if address not in wanted:
            continue
        workspace_data = raw.get("workspace")
        if isinstance(workspace_data, dict):
            workspace = str(workspace_data.get("name") or workspace_data.get("id") or "")
        else:
            workspace = str(workspace_data or "")
        at = raw.get("at") if isinstance(raw.get("at"), list) else [0, 0]
        size = raw.get("size") if isinstance(raw.get("size"), list) else [0, 0]
        baselines[address] = ClientGeometryBaseline(
            address=address,
            workspace=workspace,
            floating=raw.get("floating") is True,
            x=int(at[0]) if at else 0,
            y=int(at[1]) if at else 0,
            width=int(size[0]) if size else 0,
            height=int(size[1]) if size else 0,
        )
    return baselines


def _pick_monitor_for_client(
    address: str,
    runner: CommandRunner,
) -> CarouselMonitor:
    client = _client_at_address(address, runner)
    monitors = [
        _logical_monitor(raw)
        for raw in _read_json_array("monitors", runner)
        if isinstance(raw, dict)
    ]
    if not monitors:
        raise HyprctlError("Hyprland exposed no monitors")
    if client is not None:
        mon_id = client.get("monitor")
        for monitor in monitors:
            if monitor.id == mon_id:
                return monitor
    return monitors[0]


def auto_stage_enabled(env: Mapping[str, str] = os.environ) -> bool:
    """Default on. Disable with OMP_HUD_AUTO_STAGE=0."""
    raw = env.get("OMP_HUD_AUTO_STAGE", "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


class HandsfreeCarousel:
    """Felix stage: float once, fixed L/C/R slots, switch only reassigns occupants.

    Hyprland model:
      open  → float once + place into immutable slot geometry
      switch → move only (same card size → no resize thrash)
      close → restore baselines + windowsMove animation
    """

    def __init__(self, runner: CommandRunner = subprocess.run) -> None:
        self._runner = runner
        self._baselines: dict[str, ClientGeometryBaseline] = {}
        self._members: list[str] = []
        self._active: str | None = None
        self._workspace: str | None = None
        self._layout: StageLayout | None = None
        self._placed: dict[str, tuple[int, int, int, int]] = {}
        self._prepared: set[str] = set()
        self._open = False
        self._anim_tweaked = False

    @property
    def is_open(self) -> bool:
        return self._open

    @property
    def active_address(self) -> str | None:
        return self._active

    @property
    def member_addresses(self) -> tuple[str, ...]:
        return tuple(self._members)

    def open(
        self,
        member_addresses: list[str],
        active_address: str | None = None,
    ) -> None:
        members = _normalize_member_list(member_addresses)
        if not members:
            raise HyprctlError("carousel needs at least one window")
        active = _normalize_address(active_address or members[0])
        if active not in members:
            members.insert(0, active)

        if self._open:
            self.close()

        baselines = _read_client_baselines(members, self._runner)
        missing = [address for address in members if address not in baselines]
        if missing:
            raise HyprctlError(f"carousel members not mapped: {', '.join(missing)}")

        monitor = _pick_monitor_for_client(active, self._runner)
        self._baselines = baselines
        self._members = members
        self._active = active
        self._workspace = baselines[active].workspace
        self._layout = compute_stage_layout(monitor)
        self._placed = {}
        self._prepared = set()
        self._open = True
        # Instant snaps while stage is open — multi-window windowsMove is jagged.
        _set_windows_move_animation(self._runner, enabled=False)
        self._anim_tweaked = True
        try:
            self._assign(active, prepare=True)
        except Exception:
            self.close()
            raise

    def switch(self, active_address: str) -> None:
        if not self._open or self._layout is None or self._workspace is None:
            raise HyprctlError("carousel is not open")
        active = _normalize_address(active_address)
        if active not in self._members:
            raise HyprctlError(f"{active} is not a carousel member")
        if active == self._active:
            return
        self._assign(active, prepare=False)
        self._active = active


    def close(self) -> None:
        if not self._open and not self._baselines:
            return
        baselines = dict(self._baselines)
        focus = self._active
        anim_tweaked = self._anim_tweaked
        self._open = False
        self._members = []
        self._active = None
        self._workspace = None
        self._layout = None
        self._placed = {}
        self._prepared = set()
        self._baselines = {}
        self._anim_tweaked = False
        live = _read_client_baselines(list(baselines), self._runner)
        expressions: list[str] = []
        for address, baseline in baselines.items():
            if address not in live:
                continue
            expressions.append(_lua_workspace(address, baseline.workspace))
            expressions.append(_lua_float(address, baseline.floating))
            if baseline.width > 0 and baseline.height > 0:
                expressions.append(
                    _lua_resize(address, baseline.width, baseline.height)
                )
            expressions.append(_lua_move(address, baseline.x, baseline.y))
        if focus and focus in live:
            expressions.append(_lua_focus(focus))
        try:
            _batch_lua_dispatches(self._runner, expressions)
        except HyprctlError:
            for address, baseline in baselines.items():
                if address not in live:
                    continue
                try:
                    _move_window_workspace(address, baseline.workspace, self._runner)
                    _set_window_floating(address, baseline.floating, self._runner)
                    if baseline.width > 0 and baseline.height > 0:
                        _resize_window(
                            address, baseline.width, baseline.height, self._runner
                        )
                    _move_window_pixel(address, baseline.x, baseline.y, self._runner)
                except HyprctlError:
                    continue
            if focus and focus in live:
                try:
                    _focus_window(focus, self._runner)
                except HyprctlError:
                    pass
        if anim_tweaked:
            _set_windows_move_animation(self._runner, enabled=True)


    def _assign(self, active: str, *, prepare: bool) -> None:
        assert self._layout is not None and self._workspace is not None
        layout = self._layout
        roles = _roles_for_active(self._members, active)
        desired: dict[str, tuple[int, int, int, int]] = {}
        for address in self._members:
            role = roles.get(address, "park")
            if role == "active":
                g = layout.center
            elif role == "left":
                g = layout.left
            elif role == "right":
                g = layout.right
            else:
                g = layout.park_for(self._members.index(address))
            desired[address] = (g.x, g.y, g.width, g.height)

        expressions: list[str] = []
        # Prepare (float + workspace) once per member for the session.
        if prepare:
            for address in self._members:
                if address not in self._prepared:
                    expressions.append(_lua_workspace(address, self._workspace))
                    expressions.append(_lua_float(address, True))
                    self._prepared.add(address)

        # Geometry: peeks first, active last (z-order). Skip unchanged.
        order = [a for a in self._members if roles.get(a) != "active"] + [
            a for a in self._members if roles.get(a) == "active"
        ]
        for address in order:
            x, y, w, h = desired[address]
            prev = self._placed.get(address)
            if prev is None or prev[2] != w or prev[3] != h:
                expressions.append(_lua_resize(address, w, h))
            if prev is None or prev[0] != x or prev[1] != y:
                expressions.append(_lua_move(address, x, y))
            self._placed[address] = (x, y, w, h)

        expressions.append(_lua_focus(active))
        _batch_lua_dispatches(self._runner, expressions)


def _normalize_address(address: str) -> str:
    normalized = address.lower()
    if not normalized.startswith("0x"):
        normalized = f"0x{normalized}"
    return normalized


def _normalize_member_list(member_addresses: list[str]) -> list[str]:
    members: list[str] = []
    seen: set[str] = set()
    for address in member_addresses:
        normalized = _normalize_address(address)
        if normalized in seen:
            continue
        seen.add(normalized)
        members.append(normalized)
    return members


def _roles_for_active(members: list[str], active: str) -> dict[str, str]:
    """Map address → active|left|right|park from fixed neighbor rule."""
    idx = members.index(active)
    roles = {address: "park" for address in members}
    roles[active] = "active"
    if idx > 0:
        roles[members[idx - 1]] = "left"
    if idx < len(members) - 1:
        roles[members[idx + 1]] = "right"
    return roles


@dataclass(frozen=True, slots=True)
class SlotGeom:
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True, slots=True)
class StageLayout:
    """Immutable slot geometry for one Stage session (computed once on open)."""

    center: SlotGeom
    left: SlotGeom
    right: SlotGeom
    park_origin_x: int
    park_origin_y: int

    def park_for(self, index: int) -> SlotGeom:
        # Stable off-monitor stash; same card size so role swaps don't resize.
        return SlotGeom(
            self.park_origin_x + index * 12,
            self.park_origin_y + (index % 8) * 12,
            self.left.width,
            self.left.height,
        )


def compute_stage_layout(
    monitor: CarouselMonitor,
    *,
    gap_out: int = CAROUSEL_GAP_OUT,
    gap_between: int = CAROUSEL_GAP_BETWEEN,
    bottom_safe: int = CAROUSEL_BOTTOM_SAFE,
    active_width_frac: float = CAROUSEL_ACTIVE_WIDTH_FRAC,
    active_height_frac: float = CAROUSEL_ACTIVE_HEIGHT_FRAC,
    peek_visible_frac: float = CAROUSEL_PEEK_VISIBLE_FRAC,
) -> StageLayout:
    """Fixed L/C/R positions — same size so rotate is move-only (no resize thrash)."""
    left_r, top_r, right_r, bottom_r = monitor.reserved
    bottom = max(bottom_safe, bottom_r)
    usable_w = max(320, monitor.width - left_r - right_r - gap_out * 2)
    usable_h = max(240, monitor.height - top_r - bottom - gap_out * 2)
    # One card size for all stage roles. Peeks are the same window size, just
    # shifted off-center — role changes never resize (Hyprland windowsMove only).
    card_w = max(280, round(usable_w * active_width_frac))
    card_h = max(200, round(usable_h * active_height_frac))
    center_x = monitor.x + left_r + gap_out + (usable_w - card_w) // 2
    center_y = monitor.y + top_r + gap_out + (usable_h - card_h) // 2

    peek_visible = max(96, round(monitor.width * peek_visible_frac))
    left_x = center_x - gap_between - card_w
    if left_x + card_w < monitor.x + peek_visible:
        left_x = monitor.x - card_w + peek_visible
    right_x = center_x + card_w + gap_between
    max_x = monitor.x + monitor.width - peek_visible
    if right_x > max_x:
        right_x = max_x

    return StageLayout(
        center=SlotGeom(center_x, center_y, card_w, card_h),
        left=SlotGeom(left_x, center_y, card_w, card_h),
        right=SlotGeom(right_x, center_y, card_w, card_h),
        park_origin_x=monitor.x + monitor.width + 64,
        park_origin_y=monitor.y + 64,
    )



def compute_carousel_slots(
    monitor: CarouselMonitor,
    member_addresses: list[str],
    active_address: str,
    *,
    gap_out: int = CAROUSEL_GAP_OUT,
    gap_between: int = CAROUSEL_GAP_BETWEEN,
    bottom_safe: int = CAROUSEL_BOTTOM_SAFE,
    active_width_frac: float = CAROUSEL_ACTIVE_WIDTH_FRAC,
    active_height_frac: float = CAROUSEL_ACTIVE_HEIGHT_FRAC,
    peek_visible_frac: float = CAROUSEL_PEEK_VISIBLE_FRAC,
) -> list[CarouselSlot]:
    """Compatibility wrapper: fixed layout + role assignment → slot list."""
    members = _normalize_member_list(member_addresses)
    active = _normalize_address(active_address)
    if active not in members:
        raise HyprctlError(f"active address {active_address!r} is not a carousel member")
    layout = compute_stage_layout(
        monitor,
        gap_out=gap_out,
        gap_between=gap_between,
        bottom_safe=bottom_safe,
        active_width_frac=active_width_frac,
        active_height_frac=active_height_frac,
        peek_visible_frac=peek_visible_frac,
    )
    roles = _roles_for_active(members, active)
    slots: list[CarouselSlot] = []
    for address, role in roles.items():
        if role == "park":
            continue
        if role == "active":
            g = layout.center
        elif role == "left":
            g = layout.left
        else:
            g = layout.right
        slots.append(CarouselSlot(address, g.x, g.y, g.width, g.height, role))
    return slots


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
        if _LAYOUT_BUSY.is_set():
            return
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
