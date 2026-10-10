# Exact verification commands

Set BASE_CHECKOUT and OWNER_CHECKOUT to the isolated pinned worktrees, BUN_BIN to the existing Bun 1.4.2 binary, and OUTPUT_DIR to an output directory. The actual recorded invocations used the same command arguments below; only local absolute path prefixes are parameterized here.

```sh
export PATH="$(dirname "$BUN_BIN"):$PATH"
export HOME="$OUTPUT_DIR/home"

# In each pinned worktree, sequentially:
timeout 60 bun run gen:tool-views
timeout 60 bun test packages/coding-agent/test/plugin-validation-lifecycle-review.test.ts --max-concurrency=1

timeout 60 bun test \
  packages/coding-agent/test/plugin-install-validation.test.ts \
  packages/coding-agent/test/plugin-install-git.test.ts \
  packages/coding-agent/test/plugin-install-npm-dedupe.test.ts \
  packages/coding-agent/test/extension-loader-process-exit.test.ts \
  packages/coding-agent/test/extension-loader-concurrency.test.ts \
  packages/coding-agent/test/extension-prepared-rebind.test.ts \
  packages/coding-agent/test/extension-provider-registration-rollback.test.ts \
  --max-concurrency=1

timeout 60 bun test packages/coding-agent/test/extensions-runner.test.ts \
  -t 'managed timers|session_shutdown' --max-concurrency=1

# Frozen supplemental test only, owner worktree:
node_modules/.bin/oxlint --threads=1 packages/coding-agent/test/plugin-validation-lifecycle-review.test.ts
node_modules/.bin/oxfmt --threads=1 --check packages/coding-agent/test/plugin-validation-lifecycle-review.test.ts

# Owner packages/coding-agent directory only; recorded once, blocked at 137:
GOMAXPROCS=1 timeout 120 bun run check:types

# Source/worktree checks:
git rev-parse HEAD
git diff --exit-code
git status --short
sha256sum packages/coding-agent/test/plugin-validation-lifecycle-review.test.ts
sha256sum "$NATIVE_ADDON"

# Each process snapshot:
date -u +%FT%TZ
ps -eo pid,ppid,args | awk '$3 == "/bin/sleep" && $4 == "60" { print; found=1 } END { if (!found) print "No /bin/sleep 60 process observed" }'
```

Each test command's stdout/stderr was piped to tee with pipefail, and PIPESTATUS[0] was recorded in its matching .exit file. Final regression exits were 1 for base and 0 for owner. The code under test was not commented out, patched, or substituted. The same frozen supplemental fixture was copied into each checkout before running either final regression invocation.

The source pins were fetched through git:

```sh
git fetch origin main refs/pull/15169/head
git worktree add --detach "$OWNER_CHECKOUT" 388d101eba56aeee9afd56c787f51f53e0db4105
git worktree add --detach "$BASE_CHECKOUT" b07a1c146d0d12cfc855a2c65d52f892ef319040
```

Dependency-ready setup reused existing external packages by symlink, with each @oh-my-pi workspace package linked into its own pinned checkout and the identical prebuilt native addon linked under packages/natives/native/. No install command was run.
