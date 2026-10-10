# Independent lifecycle evidence for OMP PR #15169

Result: three additional regression scenarios fail against the pinned base and pass against roboomp's pinned owner head. No new owner defect was found. This is an evidence-only review, not a competing production implementation.

- Issue: [#15167](https://github.com/can1357/oh-my-pi/issues/15167), reported by Zireael
- Fix owner: [roboomp, PR #15169](https://github.com/can1357/oh-my-pi/pull/15169)
- Base: `b07a1c146d0d12cfc855a2c65d52f892ef319040`
- Owner head: `388d101eba56aeee9afd56c787f51f53e0db4105`
- Frozen supplemental test SHA-256: `9aaaae1ff40221d1b7d5c8e4570c0b086206a38232e64f974b74cf16700258bd`

roboomp's follow-up already fixes factories that register cleanup and then throw. That finding is not repeated here. The owner's two existing cleanup-marker cases are separate from the three supplemental cases below.

## Supplemental matrix

| Scenario | Base | Owner head |
| --- | --- | --- |
| Healthy extension plus a manifest entry missing from disk | FAIL: child still running when install rejects | PASS: async cleanup finishes before rollback |
| Healthy extension plus a sibling with an import failure | FAIL: child still running when install rejects | PASS: async cleanup finishes before rollback |
| One shutdown handler throws while another performs async cleanup | FAIL: child still running when install resolves | PASS: second handler completes; install succeeds |

Final frozen run: base **0 pass / 3 fail**, exit 1; owner **3 pass / 0 fail**, exit 0.

These tests run the actual pinned PluginManager, extension loader and ExtensionRunner. Only dependency installation/package staging and directory discovery are mocked. Each real extension factory starts `/bin/sleep 60`. Its real shutdown handler schedules a managed timeout, waits 25 ms, reads a resource from the installed plugin tree, kills the child, awaits `child.exited`, and then writes a completion marker.

The resource read plus completion marker proves asynchronous cleanup finished while the installed tree was still available, before rejected installs rolled it back. On the passing owner runs, the child was already SIGTERM-exited before the harness cleanup began. The harness also holds the event loop open for 250 ms and records whether the real 200 ms `ctx.setTimeout` fired. All three final owner observations were `fired:false`. This timer observation is diagnostic-only and is not an acceptance gate or proof of automatic cancellation. A heavily stalled teardown could legitimately allow that timer to fire before cleanup finishes. The existing deterministic runner controls separately exercise the prior managed-timer contract; no cleanup claim is made for arbitrary raw timers.

The expected behavior follows the PR's stated intent to shut down successfully loaded siblings before reporting validation errors. Handler isolation and managed-timer disposal follow the pinned documentation: [extension loading](https://github.com/can1357/oh-my-pi/blob/388d101eba56aeee9afd56c787f51f53e0db4105/docs/extension-loading.md#after-loading) and [managed background work](https://github.com/can1357/oh-my-pi/blob/388d101eba56aeee9afd56c787f51f53e0db4105/docs/extensions.md#background-work-ctxsetinterval--ctxsettimeout). No new lifecycle requirement is imposed.

## Adjacent controls

- Seven existing install/loader/provider/rebinding files: base **43 pass / 0 fail**, owner **45 pass / 0 fail**. The difference is the owner's two preexisting cleanup tests in plugin-install-validation.test.ts.
- Existing runner shutdown/managed-timer selection: **5 pass / 0 fail** on each pin; 95 unrelated tests filtered out.
- Frozen supplemental test: oxlint and oxfmt --check pass, each with one worker thread.
- Owner coding-agent `bun run check:types`: **blocked**, exit **137**, terminated by SIGKILL with no TypeScript diagnostics. The cause was not verified and peak memory was not captured. No typecheck-success claim is made, and the check was not retried.

The selected controls cover install rollback, npm deduplication, git upgrades, process-exit guards, concurrent import failure isolation, prepared-factory rebinding, provider-registration rollback, and runner timer disposal. This is focused verification, not a full suite or native-source qualification.

## Isolation and child receipts

Both worktrees are isolated detached checkouts at the exact pins. All tracked production files remained unchanged. Workspace package imports resolve into the respective pinned checkout, not an adjacent checkout; the path-normalized resolutions are in logs/. Source byte hashes are in source-hashes.json.

The final base and owner runs were sequential in one shell. Each test's afterEach waits for its own spawned child and then probes that exact PID with signal 0; all six final replay children returned ESRCH after reaping. The baseline children required harness cleanup; the owner children did not. Process snapshots before base, between base and owner, and after owner observed no residual `/bin/sleep 60`. PID values in logs are execution-namespace-local. No unrelated process was killed. Unique temporary fixture directories and separate Bun processes prevent fixture/module-cache sharing between runs.

## Reproduction

Use Linux with `/bin/sleep`, Bun 1.4.2 (`744846f84`), and existing compatible dependencies. Do not install packages or rebuild native code just to replay this fixture. Prepare two dependency-ready isolated worktrees at the pins above. Their @oh-my-pi workspace symlinks must point into each respective checkout. A missing generated HTML-export asset must be produced from that checkout's own source with `bun run gen:tool-views`; this prerequisite was generated independently on both pins in the recorded run.

Run:

```sh
bash replay.sh "$BASE_CHECKOUT" "$OWNER_CHECKOUT" "$BUN_BIN" "$OUTPUT_DIR"
```

replay.sh verifies the pins, unchanged tracked files, exact addon hash and frozen fixture, generates the prerequisite from pinned source, and runs only the supplemental baseline/owner pair sequentially. It refuses to overwrite a different existing fixture. It expects base exit 1 and owner exit 0. It does not retry the blocked typecheck.

The full exact verification commands, parameterized only for local paths, are in COMMANDS.md. Final matrices, command output, exit statuses, PID receipts, process snapshots, import resolutions and generation output are in logs/. Checkout path prefixes in captured output were replaced with $BASE_CHECKOUT/$OWNER_CHECKOUT; diagnostics and results were otherwise retained.

## Dependency provenance and limits

- Existing prebuilt dependency: `@oh-my-pi/pi-natives-linux-x64@18.8.7`, 113,535,624 bytes
- Native addon SHA-256 before and after: `fa226e95db498db0b72c4c494a43d13670ffc4f4effdd559668afa4d4c6f7403`
- Its package metadata names can1357/oh-my-pi, packages/natives, as its source repository. The binary's exact build commit is unknown; this review did not compile or qualify native source. The pinned native JavaScript wrapper hashes are included separately.
- Bun revision and native package metadata are in provenance.json.
- No new package installation, full suite, native rebuild, performance benchmark, Windows/macOS execution, live registry install, or full CLI install/upgrade reproduction was performed by this review. Existing git-upgrade controls passed, but the three supplemental scenarios specifically exercise install().
- A handler that exceeds the existing shutdown deadline, or arbitrary side effects outside the managed APIs, remains subject to the documented runner limits. This review does not promise cleanup of uncooperative extensions.
- An optional tracing attempt in the independent audit was denied before execution. No tracing or ptrace-success claim is made. The final evidence uses normal Bun execution and PID-specific signal-0 observations.
- No upstream comment, competing fix, commit, push or publication was made by the reviewer.

During harness development, an initial assertion incorrectly treated exitCode=null as proof of a running child. Bun reports exitCode=null for a child terminated by SIGTERM too. The corrected frozen assertion accepts either exitCode or signalCode, and the final PID-checked runs add PID-specific ESRCH checks. Both pins were rerun with byte-identical corrected tests; only the final matrix above is qualification evidence.

The final fixture also removes an earlier wall-clock managed-timer acceptance assertion. Timer observations remain real but diagnostic-only; the supplemental qualification is child teardown and awaited cleanup/rollback/error isolation. Prior exploratory logs remain outside this portable bundle.

## Independent replay

An independent critic reran the final byte-identical fixture on both pins: base 0/3 fail and owner 3/0 fail. Its final command/PID/snapshot receipts are in [independent-audit/](independent-audit/); runtime provenance and the unexecuted ptrace-denial receipt are included there too. These captured outputs use the same documented path-prefix normalization as the reviewer logs.
