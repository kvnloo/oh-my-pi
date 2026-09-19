#!/usr/bin/env bash
# Load BWS machine-account token from GNOME Keyring (same item Hermes uses).
# Prints `export BWS_ACCESS_TOKEN=...` for eval; never logs the value.
set -euo pipefail
CFG="${OMP_BWS_CONFIG:-$HOME/.omp/config/bws.json}"
SERVICE="${OMP_KEYRING_SERVICE:-org.hermes.agent}"
KEY="${OMP_KEYRING_BWS_KEY:-bws-access-token}"
if [[ -f "$CFG" ]] && command -v python3 >/dev/null 2>&1; then
  # optional override from config (names only)
  _svc=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('keyring_service') or '')" "$CFG" 2>/dev/null || true)
  _key=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('keyring_key') or '')" "$CFG" 2>/dev/null || true)
  [[ -n "${_svc:-}" ]] && SERVICE="$_svc"
  [[ -n "${_key:-}" ]] && KEY="$_key"
fi
# Prefer Hermes script when present (single source of truth)
for boot in \
  "${HERMES_HOME:-}/bin/hermes-keyring-bootstrap.sh" \
  "$HOME/.hermes/bin/hermes-keyring-bootstrap.sh" \
  "$HOME/.hermes/profiles/chiefstaff/bin/hermes-keyring-bootstrap.sh" \
  /workspace/hermes-home/bin/hermes-keyring-bootstrap.sh
do
  if [[ -n "$boot" && -x "$boot" ]]; then
    HERMES_KEYRING_SERVICE="$SERVICE" HERMES_KEYRING_BWS_KEY="$KEY" exec "$boot"
  fi
done
token="$(secret-tool lookup service "$SERVICE" key "$KEY" 2>/dev/null || true)"
if [[ -z "${token// }" ]]; then
  exit 0
fi
printf 'export BWS_ACCESS_TOKEN=%s\n' "$token"
unset token
