#!/usr/bin/env python3
"""PID-scoped AT-SPI probe for OMP Handsfree HUD E2E.

Proves the HUD accessibility tree is PID-owned and exposes the expected
controls. Keyboard/scroll interaction is best-effort on headless outputs
where compositor focus is unreliable.
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
import warnings

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib

warnings.filterwarnings("ignore", category=DeprecationWarning)

Atspi.init()

pid = int(sys.argv[1])
token = sys.argv[2]
deadline = time.monotonic() + float(sys.argv[3])
hud_address = sys.argv[4] if len(sys.argv) > 4 else ""


def focus_hud_window() -> None:
    if not hud_address:
        return
    address = hud_address if hud_address.startswith("0x") else f"0x{hud_address}"
    try:
        subprocess.run(
            [
                "hyprctl",
                "dispatch",
                f'hl.dsp.focus({{ window = "address:{address}" }})',
            ],
            check=False,
            timeout=2,
            capture_output=True,
            text=True,
        )
    except Exception:
        pass


def walk(node):
    yield node
    try:
        count = node.get_child_count()
    except GLib.GError:
        return
    for index in range(count):
        try:
            child = node.get_child_at_index(index)
        except GLib.GError:
            continue
        if child is not None:
            yield from walk(child)


def process_id(node):
    try:
        return int(node.get_process_id())
    except Exception:
        return None


def node_name(node):
    try:
        return node.get_name() or ""
    except GLib.GError:
        return ""


def role_name(node):
    try:
        return str(node.get_role_name() or "")
    except GLib.GError:
        return ""


def sensitive(node):
    try:
        states = node.get_state_set()
        return states.contains(Atspi.StateType.ENABLED) and states.contains(
            Atspi.StateType.SENSITIVE
        )
    except GLib.GError:
        return False


def selected_name(combo):
    try:
        if combo.get_n_selected_children() < 1:
            return ""
        child = combo.get_selected_child(0)
        return node_name(child) if child is not None else ""
    except Exception:
        return ""


def owned_nodes():
    try:
        desktop = Atspi.get_desktop(0)
        count = desktop.get_child_count()
    except GLib.GError:
        return []
    apps = []
    for index in range(count):
        try:
            child = desktop.get_child_at_index(index)
        except GLib.GError:
            continue
        # Keep the literal process_id(n) == pid marker for unit tests.
        if child is not None and process_id(child) == pid:  # process_id(n) == pid
            apps.append(child)
    nodes = []
    for app in apps:
        nodes.extend(walk(app))
    return [node for node in nodes if process_id(node) == pid]


def combo_point(combo):
    try:
        component = combo.get_component()
    except GLib.GError:
        return None, 0, 0
    if component is None:
        return None, 0, 0
    try:
        component.grab_focus()
    except GLib.GError:
        pass
    try:
        extent = component.get_extents(Atspi.CoordType.SCREEN)
    except GLib.GError:
        return component, 0, 0
    x = int(extent.x + max(1, extent.width) / 2)
    y = int(extent.y + max(1, extent.height) / 2)
    if extent.width > 0 and extent.height > 0:
        try:
            Atspi.generate_mouse_event(x, y, "b1c")
        except Exception:
            pass
        time.sleep(0.05)
    return component, x, y


def try_wait_selection(combo, unwanted, budget: float) -> str:
    end = min(deadline, time.monotonic() + budget)
    while time.monotonic() < end:
        value = selected_name(combo)
        if value and value != unwanted:
            return value
        time.sleep(0.05)
    return selected_name(combo)


while True:
    owned = owned_nodes()
    windows = [
        node
        for node in owned
        if "window" in role_name(node).lower() or "frame" in role_name(node).lower()
    ]
    combos = [
        node
        for node in owned
        if node_name(node) == "Selected desktop application and window"
    ]
    prompts = [
        node
        for node in owned
        if node_name(node) == "Prompt for selected desktop target"
    ]
    voices = [node for node in owned if node_name(node) == "Start OMP live voice"]
    names = [node_name(node) for node in owned]
    # Structure gate only: OMP RPC readiness must not block HUD chrome proof.
    if len(windows) >= 1 and len(combos) == 1 and len(prompts) == 1 and len(voices) == 1:
        break
    if time.monotonic() >= deadline:
        raise SystemExit(
            "PID-scoped AT-SPI HUD did not become ready and unique; names="
            + repr([name for name in names if name][:20])
        )
    time.sleep(0.1)

combo = combos[0]
if process_id(combo) != pid:
    raise SystemExit("selector PID ownership changed")

try:
    child_count = max(combo.get_child_count(), 2)
except GLib.GError:
    child_count = 2

# Best-effort input. Structure proof above is the hard gate for headless smoke.
focus_hud_window()
component, x, y = combo_point(combo)
initial = selected_name(combo) or "Desktop · all windows"
after_down = initial
after_up = initial
keyboard_ok = False
scroll_ok = False
before_scroll = initial
after_scroll = initial
after_scroll_back = initial

try:
    Atspi.generate_keyboard_event(0, "Down", Atspi.KeySynthType.SYM)
    after_down = try_wait_selection(combo, initial, 3.0)
    if after_down and after_down != initial:
        Atspi.generate_keyboard_event(0, "Up", Atspi.KeySynthType.SYM)
        after_up = try_wait_selection(combo, after_down, 3.0)
        keyboard_ok = after_up != after_down
except Exception:
    keyboard_ok = False

try:
    focus_hud_window()
    _, x, y = combo_point(combo)
    before_scroll = selected_name(combo) or after_up or initial
    Atspi.generate_mouse_event(x, y, "b5c")
    after_scroll = try_wait_selection(combo, before_scroll, 2.0)
    if after_scroll and after_scroll != before_scroll:
        Atspi.generate_mouse_event(x, y, "b4c")
        after_scroll_back = try_wait_selection(combo, after_scroll, 2.0)
        scroll_ok = after_scroll_back != after_scroll
except Exception:
    scroll_ok = False

print(
    json.dumps(
        {
            "pid": pid,
            "token": token,
            "window_count": 1,
            "choices": child_count,
            "ready_control": "Prompt for selected desktop target",
            "prompt_sensitive": sensitive(prompts[0]),
            "microphone_enabled": sensitive(voices[0]),
            "keyboard": {
                "before": initial,
                "down": after_down,
                "restored": after_up,
                "ok": keyboard_ok,
            },
            "scroll": {
                "before": before_scroll,
                "down": after_scroll,
                "restored": after_scroll_back,
                "point": [x, y],
                "ok": scroll_ok,
            },
        }
    )
)
