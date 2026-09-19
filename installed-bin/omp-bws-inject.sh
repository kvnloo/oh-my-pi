#!/usr/bin/env bash
# Hermes-parity BWS inject for OMP process env.
# Usage: eval "$(~/.omp/bin/omp-bws-inject.sh)"
# Fail-open unless OMP_BWS_STRICT=1. Never prints secret values (only counts on stderr).
set -euo pipefail

strict="${OMP_BWS_STRICT:-0}"
fail() {
  echo "omp-bws-inject: $*" >&2
  if [[ "$strict" == "1" ]]; then
    exit 1
  fi
  exit 0
}

CFG="${OMP_BWS_CONFIG:-$HOME/.omp/config/bws.json}"
BOOT="${OMP_BWS_BOOTSTRAP:-$HOME/.omp/bin/omp-keyring-bootstrap.sh}"

if [[ -f "$CFG" ]]; then
  enabled=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('1' if d.get('enabled', True) else '0')" "$CFG" 2>/dev/null || echo 1)
  [[ "$enabled" == "1" ]] || exit 0
fi

# 1) Bootstrap access token from keyring if unset
if [[ -z "${BWS_ACCESS_TOKEN:-}" && -x "$BOOT" ]]; then
  # shellcheck disable=SC1090
  eval "$("$BOOT")" || true
fi
[[ -n "${BWS_ACCESS_TOKEN:-}" ]] || fail "BWS_ACCESS_TOKEN unset (keyring miss)"

# Re-export token for eval consumers (caller evals this script's stdout)
# shellcheck disable=SC2016
python3 -c 'import os; t=os.environ["BWS_ACCESS_TOKEN"]; print("export BWS_ACCESS_TOKEN="+repr(t))'

# 2) Resolve bws binary
resolve_bws() {
  if [[ -n "${OMP_BWS_BIN:-}" && -x "${OMP_BWS_BIN}" ]]; then
    printf '%s\n' "$OMP_BWS_BIN"; return 0
  fi
  for c in \
    "${HERMES_HOME:-}/bin/bws" \
    "$HOME/.hermes/profiles/chiefstaff/bin/bws" \
    "$HOME/.hermes/bin/bws"
  do
    [[ -n "$c" && -x "$c" ]] && { printf '%s\n' "$c"; return 0; }
  done
  if command -v bws >/dev/null 2>&1; then
    command -v bws; return 0
  fi
  return 1
}
BWS_BIN="$(resolve_bws)" || fail "bws binary not found"
# Prepend bws dir to PATH for child shells
python3 -c 'import os,sys; d=os.path.dirname(sys.argv[1]); print("export PATH="+repr(d+os.pathsep+os.environ.get("PATH","")))' "$BWS_BIN"

# 3) Project id / options
PROJECT_ID="${OMP_BWS_PROJECT_ID:-}"
SERVER_URL="${OMP_BWS_SERVER_URL:-}"
OVERRIDE=1
if [[ -f "$CFG" ]]; then
  PROJECT_ID="${PROJECT_ID:-$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('project_id') or '')" "$CFG")}"
  SERVER_URL="${SERVER_URL:-$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('server_url') or '')" "$CFG")}"
  OVERRIDE=$(python3 -c "import json,sys; print('1' if json.load(open(sys.argv[1])).get('override_existing', True) else '0')" "$CFG" 2>/dev/null || echo 1)
fi
[[ -n "$PROJECT_ID" ]] || fail "project_id missing"

# 4) Fetch secrets as JSON (values stay in this process only)
export BWS_ACCESS_TOKEN
BWS_CMD=("$BWS_BIN" secret list "$PROJECT_ID" --output json)
if [[ -n "$SERVER_URL" ]]; then
  BWS_CMD+=(--server-url "$SERVER_URL")
fi
json="$("${BWS_CMD[@]}" 2>/dev/null)" || fail "bws secret list failed"

# Emit export lines via python; JSON via env to avoid heredoc stdin clash
OMP_BWS_JSON="$json" OMP_BWS_OVERRIDE="$OVERRIDE" python3 <<'PY'
import json, os, re, sys, shlex
raw = os.environ.get("OMP_BWS_JSON") or ""
override = os.environ.get("OMP_BWS_OVERRIDE", "1") == "1"
try:
    data = json.loads(raw)
except Exception as exc:
    print(f"omp-bws-inject: json parse failed: {exc}", file=sys.stderr)
    sys.exit(0)
items = data if isinstance(data, list) else []
name_re = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
count = 0
for it in items:
    if not isinstance(it, dict):
        continue
    key = it.get("key") or it.get("name")
    val = it.get("value")
    if key is None or val is None:
        continue
    key = str(key)
    if not name_re.match(key):
        continue
    if (not override) and os.environ.get(key):
        continue
    print(f"export {key}={shlex.quote(str(val))}")
    count += 1
print(f"omp-bws-inject: applied {count} secrets", file=sys.stderr)
PY
