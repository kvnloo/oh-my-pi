#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/.deps/tokenomics"
# Pinned tested revision for rfc/interactive-performance-stack (override for experiments).
TOKENOMICS_REV="${TOKENOMICS_REV:-e67d76fe2f1d52a5911abc8974489a10e89bb431}"
TOKENOMICS_REPO="${TOKENOMICS_REPO:-https://github.com/kvnloo/tokenomics.git}"

if [[ ! -d "$DEST/.git" ]]; then
  git clone --filter=blob:none --no-checkout "$TOKENOMICS_REPO" "$DEST"
fi

cd "$DEST"
git fetch --depth 1 origin "$TOKENOMICS_REV" 2>/dev/null || git fetch origin "$TOKENOMICS_REV"
git checkout --detach "$TOKENOMICS_REV"

cd "$DEST/packages/typescript"
npm run build
echo "tokenomics ready: $DEST/packages/typescript @ $(git rev-parse --short HEAD)"
