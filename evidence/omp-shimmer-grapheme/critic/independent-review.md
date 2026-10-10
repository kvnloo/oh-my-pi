# Independent review: Unicode shimmer style boundaries

## Verdict

The narrow correctness change is independently verified. On the same frozen
oracle, the unchanged current-public baseline has **10 pass / 18 fail** and the
final candidate has **28 pass / 0 fail**, with **7,702 assertions** on GREEN.
The change prevents generated SGR style boundaries inside non-ASCII grapheme
clusters within a single plain-text segment, while keeping code-point animation
position and existing segment/palette ownership.

This correctness fix has a measurable Unicode rendering cost, not a speedup.
The actual wait-renderer Unicode workload gained approximately **7.9–8.8 µs per
paint** in this environment. Acceptance of that tradeoff belongs to the parent.
No candidate source was changed by this reviewer.

## Exact source and runtime

- Immutable independent baseline worktree: `../shimmer-critic-base`, detached at
  `5063baf59ec68ad3f2bff060a3ba44b0547eee15`, clean before and after tests/timing.
- Final feature worktree: `../../omp-styled-graphemes/source`, same base.
- Final candidate diff SHA256:
  `2dc59a0ba4e5b26fdc42d54e5d0f0894f6db1ff322c0957465dbcfcc3be7b91a`.
- Final `shimmer.ts` Git blob: `153964b69651c8b71df85c55e1eb8bbb9e3f3a91`.
- Final `shimmer.test.ts` Git blob: `e26d297527f2e918b7279adf858d414c41f46120`.
- Final `vibe-render.test.ts` Git blob: `3b034c92d182445fc1b87fac18999587e7e9785a`.
- Bun 1.3.14 (`0d9b296a`), official previously acquired executable.
- Official npm platform leaf `@oh-my-pi/pi-natives-linux-x64@18.8.8`, rather than
  a native build made for this review. Modern binary SHA256:
  `d90742efdc5cacadcb146f4214783333a09921013908d6e4d0983575a8fde642`.
  Baseline binary SHA256:
  `03fb4a8c424c312de3a99441696bc488da70a4689e989e29776606bdedf6991d`.
- Native binary contains `PI_NATIVES_VERSION_STAMP:18.8.8`; installed manifest
  identifies that release. The release tag resolves to
  `1ca13863a82825bdce02908b3db9713e9b084290`.
- Independent `git diff v18.8.8 5063baf... -- Cargo.toml Cargo.lock
  rust-toolchain.toml .cargo crates packages/natives` was empty. Native crate,
  native package sources, workspace crate dependencies, manifests and lockfile
  are source-equivalent. This is not an independent reproducible-build claim.

## Independent freeze and corrected causal attribution

`frozen-contract.md` was written before reading the shimmer implementation or
candidate. Its SHA256 is
`507a0881fe14dfc835ec63dc2ae8014fac9d5be8e00cbcfab7e0ea01b83db570`.

An important matched-control check invalidated the initially proposed ZWJ
real-renderer attribution. Vibe's existing `frameText → oneLineLabel` path
replaces format characters, including ZWJ, with spaces **before** shimmer.
Consequently, the initial `👩‍💻tail` expectation was also violated with animation
disabled or absent. That failure must not be presented as fixed by this patch.

The original test sources and logs are preserved as `*.frozen-v1` and
`baseline-*.v1.log`. `freeze-errata.md` records the correction. Before inspecting
any candidate source, the real-path oracle was updated to preserve that known
sanitization behavior. Direct helper tests still require complete ZWJ and family
graphemes. No sanitizer production change was made or requested.

Corrected frozen files:

- `independent.test.ts`: SHA256
  `aea93cd821cc6387af5ab6a6d549082fbdc23bc48892bd4ca3317f784d09372c`.
- `phase-and-control.test.ts`: SHA256
  `62266f555ff35683556279b48b7dba50d6626a8e744c053b055c88aa575235b2`.

Baseline and candidate harness copies differ only in static source-import paths.
The final baseline rerun also incorporates the clarified real-path test titles;
no assertion was changed after candidate inspection.

## What was verified

- Six direct-helper grapheme families: profession ZWJ, family ZWJ, variation
  selector, combining accent, regional-indicator flag, and skin-tone modifier.
  Both classic and KITT modes, 83 frame times per family, with an independent
  `Intl.Segmenter` oracle mapping every generated SGR offset to a text boundary.
- Real `createVibeToolRenderer("wait").renderResult(...).render(width)` exercises
  animated current-tool arguments, actual mini-frame construction, and native
  width truncation. Expected prefixes come from independent segmentation and
  `Bun.stringWidth`, never the truncation helper under test.
- The four causal real-path regressions are VS16, combining accent, flag and
  skin-tone inputs. Matched stable and disabled cases pass on the baseline.
  A baseline heart row can occupy 13 cells at width 12, while the corrected
  expected output omits the non-fitting whole heart cluster.
- The existing ZWJ-to-space real-path behavior passes unchanged. It is a control,
  not a claimed repaired path.
- Both rendered cell-width bounds and complete-grapheme boundaries are checked.
  Width-only success is insufficient.
- Fixed ASCII tier bytes, first-code-point tier selection, original cumulative
  code-point position, classic period wrap, KITT range/bounce, empty segments,
  disabled palette emission and native/TSP descriptors.
- Deliberately split cross-segment graphemes retain segment/palette ownership.
  They remain outside the single-segment guarantee.
- Fake `Date.now` is restored and its original function identity asserted after
  every test. The renderer is invoked on fabricated result details; no session,
  model, worker tool execution, terminal process or network service is started.
  Per-render guards reject fetch, spawn, spawnSync and serve calls. They did not
  fire. These guards apply to tested render calls, not every possible import-time
  side effect of the application's entire module graph.

Exact runtime receipts:

- `baseline-corrected-final.log`: 10 pass, 18 fail, 868 assertions, exit 1.
- `candidate-final-independent.log`: 28 pass, 0 fail, 7,702 assertions, exit 0.
- `baseline-receipt.txt`, `candidate-receipt.txt`, and `performance/host-after.txt`
  preserve source/runtime hashes. The final candidate bytes remained unchanged
  throughout timing.

## Measured cost

Workloads were frozen before candidate inspection in `benchmark.ts` (SHA256
`d3af92b27ca1c63dfec6f7e8ef1206b8056045280806d8d58c50dc97cbf9c227`). They include
ASCII and Unicode pure-helper animation plus actual wait-renderer paints at
widths 40 and 100, with disabled and stable controls. The helper keeps ZWJ; the
renderer workload applies the existing ZWJ-to-space sanitizer. They are not
identical Unicode transformations and are not represented as such.

The baseline-only calibration preceded comparative timing. Final counts and
order were frozen in `performance/run-plan.json`: 200,000 helper iterations,
10,000 renderer paints, 10,000 warmups per workload, five rounds per process.
Eight separate processes ran in baseline/candidate/candidate/baseline/baseline/
candidate/candidate/baseline order. There are 20 raw samples per arm/workload,
and four paired ratios from adjacent process medians. Within each process,
workload order alternates forward/reverse. Both arms were pinned to CPU 2.

Host: Linux x86-64, reported Intel Xeon Platinum 8573C at 2.3 GHz, nine allowed
CPUs, approximately 10 GB memory, no swap. One-minute load at arm start ranged
0.49–1.18. Other coordinated builds/tests were paused; this does not establish
that a shared host was otherwise idle. Large sample ranges and unchanged-path
control shifts show meaningful timing noise.

| Animated workload | Baseline median µs | Candidate median µs | Median difference µs | Median paired ratio |
|---|---:|---:|---:|---:|
| ASCII helper | 1.063 | 1.291 | +0.229 | 1.145× |
| Unicode helper | 0.996 | 5.753 | +4.756 | 5.395× |
| ASCII renderer, width 40 | 12.204 | 13.746 | +1.542 | 1.054× |
| ASCII renderer, width 100 | 9.828 | 11.094 | +1.266 | 1.074× |
| Unicode renderer, width 40 | 15.928 | 24.683 | +8.755 | 1.674× |
| Unicode renderer, width 100 | 13.656 | 21.536 | +7.881 | 1.645× |

The four Unicode helper paired ratios were 6.072, 5.452, 5.339 and 5.156.
For the actual Unicode renderer they were 1.554, 1.803, 1.305 and 1.795 at
width 40; 1.634, 1.656, 1.360 and 1.731 at width 100. Increased Unicode cost is
consistent across all four pairs. ASCII differences are not isolated cleanly
from noise: corresponding pair ratios cross below one, and unchanged-path
controls move in both directions. Do not assert either zero ASCII overhead or
a precise ASCII regression based on this run.

Full ranges, all four paired ratios and all control workloads appear in
`performance/summary.txt` and `performance/summary.json`. The eight raw JSON
files, per-arm host/load snapshots, baseline calibration, analysis script and
frozen run plan are retained. No outliers were removed.

These are helper calls and returned-line renderer paints, not full application
frame latency, terminal IO, end-to-end user responsiveness, cold-start time,
memory allocation counts or UI p99. There is no justified speedup claim.

## Boundaries and review judgment

The patch is narrowly scoped and preserves the reviewed native/disabled/mode
branches and animation scheduling. It uses the existing shared segmenter and
keeps original cumulative code-point phase. The documentation was corrected
before final verification to acknowledge Unicode segment iterator allocations.

The public guarantee should not be broadened to arbitrary authored ANSI,
cross-segment graphemes, native truncation generally, Markdown styling, or the
label sanitizer. ASCII behavior remains intentionally unchanged; ASCII CRLF is
an extended grapheme but still follows the existing ASCII code-point path.
Single-line tool labels normalize line breaks before shimmer.

The implementer reports 17 focused repository tests and the TUI package's
oxlint/oxfmt/type gate passing. This critic independently ran the above 28-test
oracle and timing only, not the whole monorepo suite or a visual live-terminal
interaction. Public ownership/current-head checks were handled by the parent
and implementer, rather than independently queried by this reviewer.

No upstream post, PR, push, contribution submission or candidate commit was made
by this reviewer. The previously completed SyntheticSummary change was not
modified or redone.
