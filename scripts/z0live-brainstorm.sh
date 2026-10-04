#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OMP_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_ROOT="${Z0_WORKSPACE_ROOT:-$(dirname -- "$OMP_ROOT")}"
Z0INTELLIGENCE_ROOT="${Z0INTELLIGENCE_ROOT:-$WORKSPACE_ROOT/z0intelligence}"
Z0LIVE_ROOT="${Z0LIVE_ROOT:-$WORKSPACE_ROOT/z0live}"
PYTHON_BIN="${PYTHON:-python3}"

usage() {
  cat <<'EOF'
Usage: bash scripts/z0live-brainstorm.sh [--smoke] [z0live brainstorm args...]

Starts one on-demand z0live Brainstorm session. It does not make PersonaPlex
resident at OMP startup.

Environment:
  Z0INTELLIGENCE_ROOT      sibling z0intelligence checkout
  Z0LIVE_ROOT              sibling z0live checkout
  Z0LIVE_PERSONAPLEX_ROOT  optional PersonaPlex NF4 source checkout
  Z0LIVE_PERSONAPLEX_CMD   optional custom launch command
  PYTHON                   python interpreter to use
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ ! -d "$Z0LIVE_ROOT/src/z0live" ]]; then
  echo "OMP brainstorm: z0live not found at $Z0LIVE_ROOT" >&2
  exit 2
fi

if [[ "${1:-}" == "--smoke" ]]; then
  export PYTHONPATH="$Z0LIVE_ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
  exec "$PYTHON_BIN" -m z0live.cli smoke
fi

if [[ ! -d "$Z0INTELLIGENCE_ROOT/src/z0int" ]]; then
  echo "OMP brainstorm: z0intelligence not found at $Z0INTELLIGENCE_ROOT" >&2
  exit 2
fi

plan="$(mktemp -t z0live-voice-plan.XXXXXX.json)"
cleanup() { rm -f -- "$plan"; }
trap cleanup EXIT INT TERM

set +e
PYTHONPATH="$Z0INTELLIGENCE_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  "$PYTHON_BIN" -m z0int.voice_plan brainstorm --harness omp --pretty --output "$plan"
plan_rc=$?
set -e

if (( plan_rc != 0 )); then
  echo "OMP brainstorm: z0intelligence did not admit the local voice actor:" >&2
  cat "$plan" >&2 || true
  exit "$plan_rc"
fi

export PYTHONPATH="$Z0LIVE_ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
"$PYTHON_BIN" -m z0live.cli brainstorm --plan "$plan" "$@"
