#!/bin/sh
# Requires an explicitly configured real Tern control window with this reviewed plugin loaded.
set -eu
command -v tern >/dev/null || { echo 'NOT RUN: tern is not installed' >&2; exit 2; }
CONTROL=${1:?Usage: sh tern-smoke.sh /absolute/tern-control.sock}
tern ctl --control "$CONTROL" plugins run plugin.native-visual.demo
tern ctl --control "$CONTROL" plugins expect '"sample-repo"'
tern ctl --control "$CONTROL" type '"2"'
tern ctl --control "$CONTROL" plugins expect '"Mode: churn"'
tern ctl --control "$CONTROL" key Enter
tern ctl --control "$CONTROL" plugins expect '"apps/"'
tern ctl --control "$CONTROL" key Left
tern ctl --control "$CONTROL" plugins expect '"sample-repo"'
tern ctl --control "$CONTROL" tree "[data-surface='plugin.native-visual.reply']"
tern ctl --control "$CONTROL" shot native-visual
printf '%s\n' 'Control smoke completed. Inspect the captured pixels; this script does not mint a publication receipt.'
