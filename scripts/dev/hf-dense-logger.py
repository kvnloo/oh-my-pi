#!/usr/bin/env python3
"""Dev-only dense latency/event logger for the interactive performance stack."""
from __future__ import annotations
import json, os, sys, time
from datetime import datetime, timezone
from pathlib import Path

OUT_DIR = Path(os.environ.get("HF_DENSE_LOG_DIR", "/tmp/hf-live-watch"))
OUT_FILE = OUT_DIR / "dense.log"
PID_FILE = OUT_DIR / "dense.pid"
EVENTS = frozenset({
    "live.audio_started","live.transcript_partial","live.transcript_final",
    "handsfree.local_route_start","handsfree.local_route_end","handsfree.jev_start","handsfree.jev_end",
    "stage.intent","stage.action_start","stage.action_end","stage.restore_start","stage.restore_end",
    "agent.turn_start","agent.turn_end","rlm.spill","rlm.peek","rlm.search","rlm.query_start","rlm.query_end",
    "rlm.subcall_start","rlm.subcall_end","provider.request_start","provider.first_token","provider.request_end",
    "tokenomics.emit","tool.start","tool.end",
})

def emit(event: str, **fields: object) -> None:
    if event not in EVENTS:
        raise SystemExit(f"unknown event: {event}")
    row = {"ts": datetime.now(timezone.utc).isoformat(), "mono_ms": int(time.monotonic()*1000), "event": event, **fields}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with OUT_FILE.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, separators=(",", ":")) + "\n")

def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: hf-dense-logger.py emit <event> [key=value ...]|watch", file=sys.stderr)
        return 2
    if argv[1] == "emit":
        fields = {}
        for item in argv[3:]:
            if "=" in item:
                k,v = item.split("=",1); fields[k]=v
        emit(argv[2], **fields); return 0
    if argv[1] == "watch":
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
        print(f"dense logger pid={os.getpid()} -> {OUT_FILE}", flush=True)
        try:
            while True: time.sleep(3600)
        except KeyboardInterrupt:
            return 0
    return 2

if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
