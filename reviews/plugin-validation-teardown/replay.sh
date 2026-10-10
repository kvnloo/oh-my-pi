#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 4 ]]; then
  printf 'Usage: %s BASE_CHECKOUT OWNER_CHECKOUT BUN_BIN OUTPUT_DIR\n' "$0" >&2
  exit 2
fi

base=$(realpath "$1")
owner=$(realpath "$2")
bun_bin=$(realpath "$3")
mkdir -p "$4"
out=$(realpath "$4")
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
fixture=packages/coding-agent/test/plugin-validation-lifecycle-review.test.ts
fixture_hash=9aaaae1ff40221d1b7d5c8e4570c0b086206a38232e64f974b74cf16700258bd
addon_hash=fa226e95db498db0b72c4c494a43d13670ffc4f4effdd559668afa4d4c6f7403

[[ -x /bin/sleep && -x "$bun_bin" ]]
[[ $("$bun_bin" --revision) == '1.4.2+744846f84' ]]
[[ $(sha256sum "$here/plugin-validation-lifecycle-review.test.ts" | awk '{print $1}') == "$fixture_hash" ]]

export PATH="$(dirname "$bun_bin"):$PATH"
export HOME="$out/home"
mkdir -p "$HOME"

prepare() {
  local checkout=$1 expected=$2 role=$3
  [[ $(git -C "$checkout" rev-parse HEAD) == "$expected" ]]
  git -C "$checkout" diff --exit-code
  git -C "$checkout" diff --cached --exit-code
  [[ $(sha256sum "$checkout/packages/natives/native/pi_natives.linux-x64-baseline.node" | awk '{print $1}') == "$addon_hash" ]]
  if [[ -e "$checkout/$fixture" ]]; then
    cmp "$here/plugin-validation-lifecycle-review.test.ts" "$checkout/$fixture"
  else
    cp "$here/plugin-validation-lifecycle-review.test.ts" "$checkout/$fixture"
  fi
  (cd "$checkout" && timeout 60 "$bun_bin" run gen:tool-views) 2>&1 | tee "$out/$role-generate-tool-views.log"
  (cd "$checkout" && "$bun_bin" -e 'for (const name of ["@oh-my-pi/pi-coding-agent/extensibility/plugins/manager", "@oh-my-pi/pi-utils", "@oh-my-pi/pi-natives"]) console.log(name, import.meta.resolve(name))') > "$out/$role-import-resolution.txt"
  grep -F "$checkout/packages/coding-agent/src/extensibility/plugins/manager.ts" "$out/$role-import-resolution.txt"
  grep -F "$checkout/packages/utils/src/index.ts" "$out/$role-import-resolution.txt"
  grep -F "$checkout/packages/natives/native/index.js" "$out/$role-import-resolution.txt"
}

snapshot() {
  date -u +%FT%TZ
  ps -eo pid,ppid,args | awk '$3 == "/bin/sleep" && $4 == "60" { print; found=1 } END { if (!found) print "No /bin/sleep 60 process observed" }'
}

run() {
  local checkout=$1 role=$2 expected=$3 result
  set +e
  (cd "$checkout" && timeout 60 "$bun_bin" test "$fixture" --max-concurrency=1) 2>&1 | tee "$out/$role-regression.log"
  result=${PIPESTATUS[0]}
  set -e
  printf '%s\n' "$result" > "$out/$role-regression.exit"
  [[ $result == "$expected" ]]
}

prepare "$base" b07a1c146d0d12cfc855a2c65d52f892ef319040 base
prepare "$owner" 388d101eba56aeee9afd56c787f51f53e0db4105 owner
snapshot > "$out/processes-before-base.txt"
run "$base" base 1
snapshot > "$out/processes-after-base-before-owner.txt"
run "$owner" owner 0
snapshot > "$out/processes-after-owner.txt"
printf 'Expected baseline failure and owner pass reproduced. Results: %s\n' "$out"
