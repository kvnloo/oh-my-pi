# Runner-cache source identity follow-on

This evidence-only follow-on records the pinned upstream observation `0c301e9a8c4e2e132c709982c01d46acfdf88310` from 2026-10-10 at 14:31 UTC and the preceding observation `d45ba77ee6a5efa389ab1fcde4711276e805c8dd` from 14:22 UTC. It adds no production or test-source changes to Kevin Rajan's published [runner identity repair](https://github.com/kvnloo/oh-my-pi/commit/aed6e8717b49111c02881f58c628589b66aeb32e).

## Source result

All 12 selected Git objects are identical at both observed heads and the historical tested base `01e0b5c26e267dff08c305f51d1ab56ec5a2f05d`: the runner helper, owner-private-directory helper, its three direct caller files, existing runner regression test, coding-agent manifest/type configuration, root manifest/lockfile/type configuration, and the complete `packages/utils` tree. Exact object IDs are in [receipt.json](receipt.json). The only change between the two observations is `packages/coding-agent/test/tools/browser-open-lease.test.ts`.

The upstream helper remains blob `425cb40d301bfedb2c5e21ba38f3642663358698` (3,963 bytes), with directory-only memoization. The published repair is blob `f750e5a3b7736a7e40bdf89ff08ebdb4eceaf18c` (4,098 bytes), SHA-256 `fce74606ac30122c326f1b1f2268d6037218a43793a3d77c72a603c6f808a07a`. Its bytes match Kevin Rajan's original [df9aedc implementation](https://github.com/kvnloo/oh-my-pi/commit/df9aedccee5d47dd26df33990971811bf1edfdf3). The published commit has parent `01e0b5c26e267dff08c305f51d1ab56ec5a2f05d` and tree `12547555ed50107be82cc229193d065edc03fc8e`; all nine files in its original payload are preserved byte-for-byte.

## Qualification boundary

The original [qualification packet](../runner-cache-current-20261010/README.md) remains historical evidence for base `01e0b5c26e267dff08c305f51d1ab56ec5a2f05d` and the repair applied to that base. Its references to "current head" or "current base" refer to that pinned base. No runtime, native, or type qualification is established for `d45ba77e` or `0c301e9a` by this follow-on. Identical selected objects do not establish whole-repository compatibility or qualify unrelated upstream changes.

This follow-on performed only static Git-object, byte-hash, ancestry, and payload comparisons. No tests, builds, native rebuilds, installations, or typechecks were run. The receipt is a source-identity observation, with no hosted CI, deployment, or upstream acceptance claim.

## Reproduce the source comparisons

Use the full pinned commit IDs above with `git rev-parse <commit>:<path>` for each selected path in the receipt. Inspect the published commit's raw parent and tree with `git cat-file -p <commit>`. Hash helper bytes from `git show <commit>:packages/coding-agent/src/eval/runner-cache.ts` using SHA-256. Compare the two observed upstream commits with `git diff --name-status <previous> <observed>`. No runtime execution is needed for these source comparisons.
