#!/usr/bin/env python3
"""Layout acceptance: dry geometry, live ws1, or isolated headless monitor.

See docs/handsfree-demo-features.md.

  ./scripts/test-handsfree-layout.py              # dry-run only
  OMP_ALLOW_LIVE_WS=1 ./scripts/test-handsfree-layout.py --live  # opt-in only
  ./scripts/test-handsfree-layout.py --headless   # virtual monitor, no focus steal
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shlex
import socket
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from hypr_isolation import (  # noqa: E402
    Baseline,
    IsolationError,
    assert_user_unchanged,
    clients_on_monitor,
    create_headless_output,
    dispatch_exec_isolated,
    remove_headless_output,
    require_live_ws_allowed,
    safe_dispatch,
)

REPO = Path(__file__).resolve().parents[1]
HUD_SRC = REPO / "python" / "omp-hud" / "src"
RPC_SRC = REPO / "python" / "omp-rpc" / "src"
sys.path.insert(0, str(HUD_SRC))
sys.path.insert(0, str(RPC_SRC))

from omp_hud.hyprland import (  # noqa: E402
    CAROUSEL_BOTTOM_SAFE,
    CarouselMonitor,
    _logical_monitor,
    compute_quadrant_slots,
    focused_monitor,
    hud_bottom_reserve,
    layout_quadrants,
)

CTL_SOCK = Path("/run/user/1000/omp-handsfree/ctl.sock")


def hypr_json(name: str) -> object:
    return json.loads(subprocess.check_output(["hyprctl", "-j", name], text=True))


def ctl(cmd: str) -> str:
    if not CTL_SOCK.exists():
        return "error no socket"
    with socket.socket(socket.AF_UNIX) as sock:
        sock.settimeout(2.0)
        sock.connect(str(CTL_SOCK))
        sock.sendall((cmd + "\n").encode())
        return sock.recv(4096).decode(errors="replace").strip()


def ws_members(workspace_id: int = 1) -> list[str]:
    out: list[str] = []
    for c in hypr_json("clients"):
        if not isinstance(c, dict):
            continue
        ws = c.get("workspace") or {}
        wid = ws.get("id") if isinstance(ws, dict) else ws
        if wid != workspace_id:
            continue
        if (c.get("class") or "") in {"__main__.py", "omp-hud"}:
            continue
        if c.get("address"):
            out.append(str(c["address"]))
    return out


class R:
    def __init__(self) -> None:
        self.ok: list[str] = []
        self.bad: list[str] = []

    def pass_(self, name: str) -> None:
        self.ok.append(name)

    def fail(self, name: str, detail: str) -> None:
        self.bad.append(f"{name}: {detail}")

    def report(self) -> int:
        for name in self.ok:
            print(f"  PASS  {name}")
        for name in self.bad:
            print(f"  FAIL  {name}")
        print(f"\n{len(self.ok)} passed, {len(self.bad)} failed")
        return 1 if self.bad else 0


def dry(r: R) -> None:
    mon = CarouselMonitor(0, 3000, 420, 1920, 1080, (0, 27, 0, 0))
    slots = compute_quadrant_slots(mon, gap=10, bottom_reserve=98)
    bottom = max(y + h for _x, y, _w, h in slots)
    if bottom <= 1414 - 8:
        r.pass_("quadrant geometry below HUD top (dry)")
    else:
        r.fail("quadrant geometry", f"max_bottom={bottom}")


def headless(r: R) -> None:
    """Hyprland UI testing lane: headless output, no focus steal."""
    token = f"OMP_LAYOUT_{secrets.token_hex(4)}"
    output = f"OMP-LAYOUT-{token}"
    workspace = f"omp-layout-{token}"
    suffix = secrets.token_hex(3)

    baseline = Baseline.capture()
    mon_id: int | None = None

    try:
        mon_id = create_headless_output(output)
        monitors = hypr_json("monitors")
        mon_raw = next(m for m in monitors if m.get("name") == output)
        mon = _logical_monitor(mon_raw)

        def exec_on_headless(cmd: list[str]) -> None:
            dispatch_exec_isolated(
                cmd,
                output=output,
                workspace=workspace,
                env_prefix=f"OMP_LAYOUT_TOKEN={token} ",
                baseline=baseline,
            )
            assert_user_unchanged(baseline, label="after isolated exec")

        # Four fixtures + fake HUD bar at bottom center
        addresses: list[str] = []
        for i in range(4):
            cls = f"{token}-w{i}"
            exec_on_headless(
                [
                    "kitty",
                    "--single-instance=no",
                    "--class",
                    cls,
                    "--title",
                    f"{token} win{i}",
                    "sh",
                    "-c",
                    "sleep 300",
                ]
            )
            time.sleep(0.15)

        time.sleep(0.4)
        for c in clients_on_monitor(mon_id):
            if str(c.get("class", "")).startswith(token):
                addresses.append(str(c["address"]))
        if len(addresses) < 4:
            r.fail("headless fixtures", f"got {len(addresses)} windows")
            return

        # Fake HUD: title match for hud_bottom_reserve
        exec_on_headless(
            [
                "kitty",
                "--single-instance=no",
                "--class",
                f"{token}-hud",
                "--title",
                "OMP Handsfree Mode",
                "sh",
                "-c",
                "sleep 300",
            ]
        )
        time.sleep(0.3)
        hud = next(
            (
                c
                for c in hypr_json("clients")
                if isinstance(c, dict)
                and str(c.get("title", "")).startswith("OMP Handsfree Mode")
                and c.get("monitor") == mon_id
            ),
            None,
        )
        if hud is None:
            r.fail("fake hud", "not on headless monitor")
            return

        hud_addr = str(hud["address"])
        scale = float(mon_raw.get("scale") or 1)
        lw = round(float(mon_raw.get("width", 0)) / scale)
        lh = round(float(mon_raw.get("height", 0)) / scale)
        hx = int(mon_raw.get("x", 0)) + (lw - 688) // 2
        hy = int(mon_raw.get("y", 0)) + lh - 70 - 16
        safe_dispatch(["hyprctl", "dispatch", "setfloating", f"address:{hud_addr}"], baseline)
        safe_dispatch(
            [
                "hyprctl",
                "dispatch",
                "resizewindowpixel",
                f"exact 688 70,address:{hud_addr}",
            ],
            baseline,
        )
        safe_dispatch(
            [
                "hyprctl",
                "dispatch",
                "movewindowpixel",
                f"exact {hx} {hy},address:{hud_addr}",
            ],
            baseline,
        )
        time.sleep(0.2)

        reserve = hud_bottom_reserve(mon)
        r.pass_(f"hud_bottom_reserve={reserve}")

        laid = layout_quadrants(addresses[:4], focus_first=False)
        time.sleep(0.3)
        clients_map = {c["address"]: c for c in hypr_json("clients") if c.get("address")}
        hud_live = clients_map.get(hud_addr)
        hud_top = int(hud_live["at"][1]) if hud_live else hy
        max_bottom = 0
        for addr in laid:
            c = clients_map.get(addr)
            if not c:
                continue
            bottom = int(c["at"][1]) + int(c["size"][1])
            max_bottom = max(max_bottom, bottom)
        if max_bottom <= hud_top - 8:
            r.pass_("headless quad above fake HUD")
        else:
            r.fail(
                "headless quad",
                f"max_bottom={max_bottom} hud_top={hud_top} reserve={reserve}",
            )

        # Stage restore path: stack one window centered (carousel substitute)
        zen_addr = laid[0]
        safe_dispatch(
            [
                "hyprctl",
                "dispatch",
                "resizewindowpixel",
                f"exact 900 600,address:{zen_addr}",
            ],
            baseline,
        )
        safe_dispatch(
            [
                "hyprctl",
                "dispatch",
                "movewindowpixel",
                f"exact {mon.x + 40} {mon.y + 40},address:{zen_addr}",
            ],
            baseline,
        )
        r.pass_("headless stage-like single window")

    finally:
        remove_headless_output(output)
        for c in clients_on_monitor(mon_id) if mon_id is not None else []:
            cls = str(c.get("class", ""))
            title = str(c.get("title", ""))
            if token in cls or token in title:
                safe_dispatch(
                    [
                        "hyprctl",
                        "dispatch",
                        "closewindow",
                        f"address:{c['address']}",
                    ],
                    baseline,
                )
        if not baseline.matches_current():
            baseline.restore_focus()
        try:
            assert_user_unchanged(baseline, label="after headless teardown")
            r.pass_("user focus preserved after headless")
        except IsolationError as err:
            r.fail("user isolation", str(err))


def live(r: R) -> None:
    try:
        require_live_ws_allowed()
    except IsolationError as err:
        r.fail("live gate", str(err))
        return
    members = ws_members()
    if len(members) < 2:
        r.fail("windows", f"need >=2 on ws1, got {len(members)}")
        return
    laid = layout_quadrants(members[:4])
    time.sleep(0.4)
    clients = {c["address"]: c for c in hypr_json("clients") if c.get("address")}
    max_bottom = max(
        int(clients[a]["at"][1]) + int(clients[a]["size"][1])
        for a in laid
        if a in clients
    )
    mon = focused_monitor()
    hud_y = None
    for c in hypr_json("clients"):
        if c.get("class") in {"__main__.py", "omp-hud"}:
            hud_y = int(c["at"][1])
    if mon:
        reserve = hud_bottom_reserve(mon) if hud_y else CAROUSEL_BOTTOM_SAFE
        ceiling = (hud_y if hud_y else mon.y + mon.height - reserve)
        if max_bottom <= ceiling - 4:
            r.pass_("live quad above HUD reserve")
        else:
            r.fail("live quad", f"max_bottom={max_bottom} ceiling={ceiling}")
    if CTL_SOCK.exists():
        ctl("stage")
        time.sleep(0.6)
        if "carousel=open" in ctl("status") or "mode=stage" in ctl("status"):
            r.pass_("ctl stage opens carousel")
        else:
            r.fail("stage restore", ctl("status"))
    else:
        r.fail("ctl", "socket missing (start Handsfree for live ctl tests)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Test on user's ws1")
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Isolated headless monitor (hyprland-ui-testing)",
    )
    args = parser.parse_args()

    r = R()
    print("=== Handsfree layout acceptance ===\n")
    dry(r)
    if args.headless:
        print()
        headless(r)
    if args.live:
        print()
        live(r)
    return r.report()


if __name__ == "__main__":
    raise SystemExit(main())
