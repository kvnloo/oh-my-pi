#!/bin/sh
# Explicit control window only; evidence goes outside the watched plugin directory.
set -eu
exec node "$(dirname "$0")/capture.mjs" "$@"
