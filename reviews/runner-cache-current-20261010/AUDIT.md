# Independent OMP current-head qualification

Reviewed 2026-10-10. Verdict: **PASS for this bounded runner identity helper on the pinned current head**. This is not a native rebuild/certification, full runtime suite or upstream acceptance verdict.

## Exact source and independent replay

Both arms are based on current main `01e0b5c26e267dff08c305f51d1ab56ec5a2f05d`. The candidate only reapplies the published `df9aedccee5d47dd26df33990971811bf1edfdf3` runner helper patch; no new production design was introduced. The ordinary filename still contains the existing source hash and extension; the new memo guard requires that filename before reuse and keeps the existing owner-private-directory and deleted-file recovery paths.

Independent replay used Bun 1.4.2 `(744846f84)` and the unchanged prebuilt 18.8.7 native dependency. Arm-local `pi-utils`, `pi-natives` and coding-agent imports were independently checked. Source and frozen grader SHA-256 values were captured before and after replay; no implementation or grader bytes changed.

Frozen primary suite SHA-256 `163ccc44fad36190e01a34869abf0ea98b05c86c58bcb05958dede6fbe210d56`:

- Current baseline: 6 passes, 2 failures, exit 1.
- Exact candidate: 8 passes, 0 failures, exit 0.

Existing independent probe suite SHA-256 `77bd616952b3f5f166df1248b7a2fe142d069882ce82d3d56fae08a55e6168c8`:

- Current baseline: 3 passes, 6 failures, exit 1.
- Exact candidate: 9 passes, 0 failures, exit 0.

These are separate suite outcomes, not a blended score. The probes exercise executable A/B/A source identity, extension alternation, unchanged-content no-rewrite, directory isolation, deletion after identity changes, overlapping calls, permission repair and changed-source symlink replacement. Baseline failures include stale requested source/extension and related identity alternation/recovery consequences; they are actual output failures rather than collection errors.

## Types and runtime limits

The separate, exclusive current-head `bun run check:types` completed at 13:02:14 UTC: exit 0, 48.593 seconds, peak child RSS 4,203,956 KiB. I inspected its actual log and result receipt and rechecked the candidate/helper/grader hashes afterward; no second compiler run was needed. The initial missing `/usr/bin/time` exit 127 is a pre-execution failure, preserved separately and not counted as a compiler run or pass. This new-head result is independent of the previous wave's resource-blocked typecheck.

The addon remains SHA-256 `fa226e95db498db0b72c4c494a43d13670ffc4f4effdd559668afa4d4c6f7403`; build commit is unknown because it is a prebuilt dependency. No native rebuild was run. Earlier missing-addon-link collection failures remain preserved in the bundled qualification receipts and are not counted as correctness contrasts. This audit reused the now-readable addon links and made no dependency/link/source edits.

The helper's existing noncryptographic source-hash naming and filesystem assumptions are unchanged. These bounded tests do not establish content-integrity guarantees, arbitrary caller-input validation, all operating systems, a native correctness certificate, production deployment or hosted CI. No action was taken on #15169.

Evidence is bundled by original filename in audit-logs.json, run-logs.json and receipts.json.
