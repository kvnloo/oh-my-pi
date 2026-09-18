#!/usr/bin/env bash
# Dev-only Handsfree / interactive-stack status monitor (inspect-only, not a control plane).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CTL="${OMP_HANDSFREE_CTL:-$ROOT/scripts/omp-handsfree-ctl}"
RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/omp-handsfree"

while true; do
  clear
  date -Is
  echo "=== omp-handsfree ctl status ==="
  "$CTL" status 2>/dev/null || echo "(ctl unavailable)"
  echo
  echo "=== runtime ==="
  ls -la "$RUNTIME" 2>/dev/null || echo "(no runtime dir)"
  echo
  echo "=== recent dense log (tail) ==="
  tail -n 8 /tmp/hf-live-watch/dense.log 2>/dev/null || echo "(no dense.log — start hf-dense-logger.py)"
  sleep 2
done
