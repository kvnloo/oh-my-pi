#!/usr/bin/env python3
"""Restore dotfiles dwindle tiling after Handsfree / Stage experiments."""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "python" / "omp-hud" / "src"))
sys.path.insert(0, str(REPO / "python" / "omp-rpc" / "src"))

from omp_hud.hyprland import restore_native_layout  # noqa: E402


def main() -> int:
    restored = restore_native_layout()
    print(f"restored {len(restored)} windows")
    for addr in restored:
        print(f"  {addr}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
