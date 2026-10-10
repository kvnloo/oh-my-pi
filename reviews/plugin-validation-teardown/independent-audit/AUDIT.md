# Independent final lifecycle evidence audit

Verdict: **PROMOTE as supporting evidence for roboomp's existing OMP PR #15169**. No new owner defect was found. This is additional test evidence, not a competing production fix. No production edits, upstream comments, API calls, commits, pushes, or publication were performed by this critic.

## Certified executable inputs and result

- Base: `b07a1c146d0d12cfc855a2c65d52f892ef319040`.
- Owner: `388d101eba56aeee9afd56c787f51f53e0db4105`.
- Final supplemental fixture SHA-256: `9aaaae1ff40221d1b7d5c8e4570c0b086206a38232e64f974b74cf16700258bd`. The frozen evidence, portable fixture, and `$BASE_CHECKOUT` / `$OWNER_CHECKOUT` copies are byte-identical.
- Independent sequential replay on Bun 1.4.2 (`744846f84`): **base 0 pass / 3 fail, exit 1; owner 3 pass / 0 fail, exit 0**. See `base-replay.log/.exit`, `owner-replay.log/.exit`, and `replay-provenance.txt` alongside this audit. The 30-second outer timeout with 5-second kill grace was not reached.
- All three baseline failures occur at the live-child assertion. Baseline PIDs 45/46/47 needed harness cleanup; owner PIDs 105/106/107 were already SIGTERM-exited before it. All six awaited child-exit results were 143; all six subsequent PID existence checks returned ESRCH. All four independent before/after `/bin/sleep 60` snapshots are empty. PIDs are execution-namespace-local. This is fixture-owned process evidence, not arbitrary descendant-tree tracing.

## Acceptance and diagnostic scope

The acceptance gates remain: a real spawned child has terminated when install settles; a 25 ms asynchronous shutdown handler completed; its exact marker proves it read the installed resource before failed-install rollback; rejected installs restore dependencies/remove the package; a throwing shutdown handler does not prevent another handler's cleanup.

The former 200 ms timer absence assertion is removed. The real `ctx.setTimeout` and 250 ms observation emit **diagnostic-only** `managedTimerDiagnostic.fired` values. All three independent owner observations were false. That observation does not decide test success and must not be described as proof of cancellation. A heavily stalled teardown could legitimately let the timer fire while cleanup is still running.

No narrow deterministic public active/disposed timer-state API was found in the installed Bun Timer surface (ref/unref/hasRef/refresh). Managed handles are already unref'd, and the production manager's handle set is private. Diagnostic-only timing avoids a false-red without widening mocks or editing production code. The separately recorded **existing** runner controls are 5 pass / 0 fail on both pins; their controlled/fake-time managed-timer tests are separate coverage.

The pinned contract supports the child/cleanup/error-isolation expectations: `packages/coding-agent/src/extensibility/plugins/manager.ts:124–150,464–483`; `extensions/runner.ts:439–450,1443–1450,1585–1597`; `docs/extension-loading.md:334–343`; `docs/extensions.md:342–363,1061–1063`. Shutdown handlers have a two-second budget, with no guarantee to undo arbitrary detached side effects.

## Portable content and provenance review

`reviewed-content.sha256.json` binds the reviewed README, commands, replay script, results, provenance, source-hash document, and fixture. All **46** source/fixture hash checks against the two pinned worktrees match (`source-hash-validation.json`). No tracked worktree changes were present. `bash -n replay.sh` passed; this critic inspected the script but did not execute its setup/generation steps.

The replay script checks exact pins, unstaged/staged tracked diffs, fixture/addon hashes and worktree-local import resolution. It refuses a different preexisting fixture, generates the prerequisite from pinned source, and runs the baseline/owner supplement sequentially. Its result checks are exit-code checks; the logs provide the scenario matrix and PID receipts.

Runtime provenance resolves each checkout's own manager/loader/runner/pi-utils source. Both load the identical **prebuilt** native addon 18.8.7, SHA-256 `fa226e95db498db0b72c4c494a43d13670ffc4f4effdd559668afa4d4c6f7403`. Its `stale: false` field is a runtime self-report, not independent native-source freshness/build certification. The addon's exact build commit is unknown; no native rebuild occurred.

## Remaining limits

- Existing adjacent controls were inspected, not independently rerun: base 43/0, owner 45/0 across the same seven files. The owner's two existing shutdown tests explain the count delta. Existing runner controls are 5/0 on both pins.
- Package type checking remains **unverified**: SIGKILL / exit 137, no TypeScript diagnostics. No full-suite, native build, clean-install, CLI/binary end-to-end, CI, or upstream-state certification.
- Ptrace was denied before Bun execution. No process trace executed, and no tracing/escalation retry occurred. The denial is retained in `base-ptrace-denial.log/.exit`; PID observations are not strace coverage.
- Earlier timer-gated and exitCode-only exploratory reports are superseded and excluded from final qualification. The final diagnostic-only fixture hash above is the accepted one.
- The portable manifest excludes itself. Its complete byte validation is performed after all companion receipts and this audit are copied; the final manifest receipt is reported separately so there is no recursive hash claim.
