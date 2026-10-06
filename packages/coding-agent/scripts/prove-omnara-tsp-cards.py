#!/usr/bin/env python3
"""Prove native Tern tool cards from an OMP × Omnara TSP recording.

Cell text is insufficient proof because Tern renders a tool header as a native
`tool` node. This script inspects recorded TSP ops directly.

Usage:
  python3 packages/coding-agent/scripts/prove-omnara-tsp-cards.py RECORD.jsonl [TOOL_NAME...]

Examples:
  python3 packages/coding-agent/scripts/prove-omnara-tsp-cards.py /tmp/omnara.jsonl bash read task
"""

from __future__ import annotations

import json
import sys
from collections import Counter


def cards(path: str) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    with open(path, errors="replace") as stream:
        for line in stream:
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
                found.append(
                    (
                        str(props.get("name") or ""),
                        str(props.get("target") or props.get("title") or ""),
                    )
                )
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print(
            "usage: prove-omnara-tsp-cards.py RECORD.jsonl [TOOL_NAME...]",
            file=sys.stderr,
        )
        return 2

    found = cards(sys.argv[1])
    counts = Counter(name for name, _target in found)
    print(f"cards {len(found)}")
    for index, (name, target) in enumerate(found, 1):
        print(f"{index:02d} {name} {target}")

    missing = [name for name in sys.argv[2:] if counts[name] == 0]
    if missing:
        print("missing native tool cards: " + ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
