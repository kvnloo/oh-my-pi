#!/usr/bin/env python3
"""Prove native Tern tool cards from a TSP recording.

`tern capture --surfaces` is not proof. Tern draws a tool head as a `tool`
node. That head is absent from the cell text. A slice is not done until this
script prints the expected cards and exits 0.

Usage:
  python3 packages/coding-agent/scripts/prove-tsp-cards.py RECORD.jsonl 20
"""

from __future__ import annotations

import json
import sys


def cards(path: str) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    for line in open(path, errors="replace"):
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        for op in (obj.get("body") or {}).get("ops") or []:
            if not isinstance(op, list) or not op or op[0] != "add":
                continue
            node = op[-1]
            if not isinstance(node, dict) or node.get("k") != "tool":
                continue
            props = node.get("p") or {}
            found.append((str(props.get("name") or ""), str(props.get("target") or props.get("title") or "")))
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: prove-tsp-cards.py RECORD.jsonl [COUNT]", file=sys.stderr)
        return 2
    found = cards(sys.argv[1])
    print(f"cards {len(found)}")
    for index, (name, target) in enumerate(found, 1):
        print(f"{index:02d} {name} {target}")
    if len(sys.argv) > 2 and len(found) != int(sys.argv[2]):
        print(f"expected {sys.argv[2]} cards, found {len(found)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
