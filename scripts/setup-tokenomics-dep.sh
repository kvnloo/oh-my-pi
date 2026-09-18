#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.deps/tokenomics"
if [[ ! -d "$DEST/.git" ]]; then
  git clone --depth 1 https://github.com/kvnloo/tokenomics.git "$DEST"
fi
cd "$DEST/packages/typescript"
npm run build
echo "tokenomics ready: $DEST/packages/typescript"
