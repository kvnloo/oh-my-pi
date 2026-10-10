# Current-upstream runner-cache qualification

Base: can1357/oh-my-pi at 01e0b5c26e267dff08c305f51d1ab56ec5a2f05d, fetched 2026-10-10 at 12:52 UTC.
Candidate: only the already-published df9aedccee5d47dd26df33990971811bf1edfdf3 helper patch reapplied to this base, plus its unchanged frozen regression test. No new production design. The upstream helper is still byte-identical to the older base b07a1c146d.

## Fresh runtime evidence

| Gate | Unchanged current base | Published helper on current base |
| --- | --- | --- |
| Frozen runner regression suite | 6 passed, 2 failed | 8 passed |
| Existing independent probes | 3 passed, 6 failed | 9 passed |
| Actual coding-agent package typecheck | Not run | Passed, exit 0 |

The fresh independent critic repeated both runtime matrices and verified arm-local imports and unchanged hashes. The two primary failures are consumer-visible: a changed runner source executes the previous source, and a changed extension returns the previous extension. No mock replaces the staging helper or spawned executable.

Frozen regression SHA-256: 163ccc44fad36190e01a34869abf0ea98b05c86c58bcb05958dede6fbe210d56.
Frozen independent probes SHA-256: 77bd616952b3f5f166df1248b7a2fe142d069882ce82d3d56fae08a55e6168c8.
Candidate helper SHA-256: fce74606ac30122c326f1b1f2268d6037218a43793a3d77c72a603c6f808a07a.

## Full package types

One actual current-head compiler run passed through `bun run check:types`, executing `tsgo -p tsconfig.json --noEmit`, with GOMAXPROCS=2 and GOMEMLIMIT=2GiB. It ran alone after a 6,062-MiB available-RAM preflight. Elapsed 48.593 seconds; peak child RSS 4,203,956 KiB. The 150-second timeout was not reached. Before/after source hashes agree. This is a new current-head result, not the historical prior-wave pass.

An initial wrapper invocation returned 127 because /usr/bin/time is absent. The compiler did not start in that attempt. Those files are retained separately. The actual run used Python's monotonic clock and resource.getrusage(RUSAGE_CHILDREN). GOMEMLIMIT is a soft Go target, not an RSS ceiling.

## Setup and limits

Bun 1.4.2 (744846f84) and an existing 18.8.7 native addon survived under /tmp. The initial tests failed collection because the isolated trees lacked an addon link; those logs remain named initial-missing-addon. Each isolated tree then received its own link to the same unchanged prebuilt dependency, SHA-256 fa226e95db498db0b72c4c494a43d13670ffc4f4effdd559668afa4d4c6f7403. Native build commit is unknown. No native source qualification, rebuild, installation, Windows test or full CLI workflow is claimed. Workspace package imports resolve into each arm's own source tree; external packages are reused read-only.

Full workspace checks, full test suite, package build, current-head hosted CI and upstream acceptance are unverified. Implementation and primary regressions reapply Kevin Rajan’s published [df9aedc](https://github.com/kvnloo/oh-my-pi/commit/df9aedccee5d47dd26df33990971811bf1edfdf3) without redesign; existing source architecture remains unchanged. This is a current-base qualification of that bounded fix. No upstream PR/comment was made.

## Exact commands

From each corresponding worktree:

```sh
<bun> test packages/coding-agent/test/runner-cache-restage.test.ts
<bun> test validation/runner-cache-identity/independent-probes.test.ts
```

From the candidate's packages/coding-agent directory, with Bun on PATH:

```sh
GOMAXPROCS=2 GOMEMLIMIT=2GiB timeout -k 5 150 bun run check:types
```

Focused oxlint and oxfmt checks passed on the helper, frozen primary test and independent probe; git diff --check passed. Full workspace checks remain unrun.

Raw logs and exit statuses are in run-logs.json, the independent replay is in audit-logs.json, and source/resource identity is in receipts.json. Initial collection and pre-execution wrapper failures are explicitly retained, not counted as test or compiler executions. Absolute checkout and dependency locations are replaced with portable placeholders; diagnostic content is otherwise preserved. The initial identity receipt contains pre-run pending labels; this final report and the actual exit receipts supersede those labels. Public file byte hashes are recorded in manifest.json.
