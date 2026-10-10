# OMP shimmer: generated ANSI boundaries within Unicode graphemes

## Status and source

This is a downstream, evidence-only packet for a narrow correctness change. The
tested local source commit is `667fe0078b30b07826f13acac56faf2df98a1b77`.
The [published downstream source commit](https://github.com/kvnloo/oh-my-pi/commit/abf7c59e76078fe7ec6ead20668f1cbe2e07d90e)
is `abf7c59e76078fe7ec6ead20668f1cbe2e07d90e` on
`fix/omp-shimmer-grapheme-20261010` in `kvnloo/oh-my-pi`. The connector
assigned different author/date metadata, but independent GitHub readback
verified its exact tested tree (`176ebfa50792ba6b5ed118f7e52914dd9042d98b`)
and all three file bytes. Both commits have the same sole parent,
upstream `can1357/oh-my-pi` main `5063baf59ec68ad3f2bff060a3ba44b0547eee15`.
`fix.patch` is the exact 3-file commit diff, SHA-256
`2dc59a0ba4e5b26fdc42d54e5d0f0894f6db1ff322c0957465dbcfcc3be7b91a`.
No source, test, or timing bytes were changed after the final independent replay.
The connector lists the linked account, Kevin Rajan, as Git author/committer;
its commit message identifies dot as the AI assistant that authored the patch.
That metadata is not a claim of Kevin's manual authorship or review.

**Upstream contribution is on HOLD.** The correctness fix has a measured Unicode
paint cost, and human review of that tradeoff and repository contribution
requirements must precede any PR. This packet is not an upstream submission or
a performance-improvement claim. It does not include a PR, issue, comment, or
changelog placeholder.

Original context and credit: @can1357 authored shimmer. @roboomp's prior
scanner/performance work appears in [#4354](https://github.com/can1357/oh-my-pi/pull/4354)
and [#4383](https://github.com/can1357/oh-my-pi/pull/4383), following CPU reports
by @szavadsky in [#4353](https://github.com/can1357/oh-my-pi/issues/4353)
and [#4377](https://github.com/can1357/oh-my-pi/issues/4377). This patch
does not claim their work or reproduce their fixes.

## Causal bug and exact fix

In the animated `createVibeToolRenderer("wait")` path, shimmer can insert a
generated SGR color boundary between a heart and its VS16 variation selector.
At fixed phase 467 ms and width 14, the baseline renders `│ └ read: ❤️ta…`
at 15 cells, while the independent whole-grapheme prefix is
`│ └ read: ❤️t…` at 14. Stable and disabled controls already render the
expected row. The committed repository test is RED on the pinned baseline
(15 pass, 2 fail across the focused files) and GREEN on the candidate
(17 pass, 0 fail). See `shipping-tests-baseline-red.log` and
`focused-tests-final.log`.

The patch uses the existing `getSegmenter()` only for non-ASCII text inside a
single shimmer input segment. It selects the tier at a grapheme's first code
point, advances the shared sweep by the original number of code points, and
emits each run only at full grapheme boundaries. The ASCII loop, palette
ownership, disabled path, native/TSP description, and motion formulas stay as
before. No native Rust source is edited. The exact direct-helper regression
also covers ZWJ profession, heart+VS16, combining accent, regional-indicator
flag, family ZWJ, and skin-tone modifier clusters.

## Oracle correction and limits

The first proposed **real-renderer ZWJ** fixture was confounded: vibe's existing
`frameText → oneLineLabel` sanitizer replaces Unicode Cf, including ZWJ, with
spaces before shimmer. Stable and disabled controls expose the same change.
Thus a ZWJ input to this real path is **not** evidence of a shimmer-specific
defect or of this patch restoring the joined glyph. The independent reviewer
corrected the real-path oracle before inspecting candidate source and retained
the original fixture/log plus `critic/freeze-errata.md`.
`baseline-real-renderer-red.log` is the **superseded, confounded ZWJ witness**,
preserved for audit only; it is not counted as causal RED evidence. Direct shimmer helper
ZWJ tests remain valid. Four unaffected real-path families (VS16, combining,
flag, skin tone) remain causal. Neither sanitizer nor native truncation was
changed.

The guarantee is generated SGR boundaries within a **single** Unicode text
segment. A grapheme deliberately split across different palette segments
retains the existing segment/palette boundary. Arbitrary authored ANSI,
Markdown independently styled spans, CRLF on the unchanged ASCII path,
terminal screenshot behavior, and other native text-width concerns are outside
this fix.

## Verification

- Corrected independent frozen oracle: baseline `10 pass / 18 fail`, 868
  assertions; candidate `28 pass / 0 fail`, 7,702 assertions. The same
  assertions exercise six direct grapheme families in classic and KITT across
  83 phases each; independent `Intl.Segmenter` boundaries; actual wait rows;
  stable/disabled, ASCII, palette, native, and timing controls. Logs and exact
  run-specific test sources are in `critic/`.
- Exact committed shipping tests on clean baseline with test file blobs
  SHA-matched to the candidate: `15 pass / 2 fail`. The two failures are the
  wait-renderer heart row and direct generated-SGR boundary assertion.
- Candidate focused tests: `17 pass / 0 fail`, 115 assertions.
- Six adjacent TUI suites: `236 pass / 0 fail`, 1,186 assertions
  (`adjacent-tests-final.log`). Package `oxlint`, `oxfmt`, and `tsgo` pass
  (`tui-check-final.log`). `git diff HEAD^ HEAD --check` passes.
- Full monorepo tests, a live terminal visual session, and a local native Rust
  rebuild were not performed. No remote CI result is claimed.

## Measured Unicode cost: reason for HOLD

The independent reviewer froze the workloads and iteration plan before
comparing arms, ran eight interleaved baseline/candidate processes pinned to
CPU 2, and retained all raw measurements in `critic/performance/`. There were
20 samples per arm/workload, four adjacent process pairs, no removed outliers.
These are per-call helper costs and returned-line wait-renderer paints, not
end-to-end application frames or terminal I/O. The real wait workload applies
the preexisting ZWJ sanitizer; the direct helper workload does not.

| Animated workload | Baseline median | Candidate median | Delta | Paired median ratio |
|---|---:|---:|---:|---:|
| Unicode helper | 0.996 µs | 5.753 µs | +4.756 µs | 5.395× |
| Unicode wait renderer, width 40 | 15.928 µs | 24.683 µs | +8.755 µs | 1.674× |
| Unicode wait renderer, width 100 | 13.656 µs | 21.536 µs | +7.881 µs | 1.645× |

All four paired Unicode wait-renderer ratios exceeded 1.30× at each width.
ASCII helper and renderer medians rose by 0.23 µs and 1.27–1.54 µs
respectively, but matched unchanged-path controls also moved, so this run
cannot isolate or precisely attribute an ASCII difference. No Unicode
performance gain is claimed. `critic/performance/summary.txt` gives all
workloads, ranges, ratios, and stable/disabled controls.

## Replaying the recorded checks

The recorded setup used official Bun 1.3.14 and official npm
`@oh-my-pi/pi-natives-linux-x64@18.8.8` binaries. Bun identity provenance is
`bun-identity-source.txt`. The native sources, manifests, Cargo lockfile, and
workspace crate dependencies at the baseline are identical to upstream
`v18.8.8` (`1ca13863a82825bdce02908b3db9713e9b084290`); the candidate
changes none of them. The prebuilt validates this unchanged native base, not
any hypothetical modified Rust. A fresh checkout needs its own frozen
workspace dependencies and the official platform leaf; see the exact setup
provenance in `critic/independent-review.md` and the raw receipts.

At the final pre-publication read, upstream main had advanced three commits to
`fa5ff4a3a977a28b93d025f4cf50f046e019f18c`. None changed the shimmer
scanner, vibe renderer, or the two modified tests, but release dependency and
lock files did change. The recorded checks and native equivalence apply to
the pinned `5063baf` parent, **not** to that newer main or a hypothetical
rebase. The branch is held for downstream owner review, not ready-to-merge CI.

From a checkout of the source commit, run:

    bun test packages/tui/test/shimmer.test.ts packages/tui/test/vibe-render.test.ts
    bun test packages/tui/test/shimmer.test.ts packages/tui/test/vibe-render.test.ts packages/tui/test/loader.test.ts packages/tui/test/text-utils.test.ts packages/tui/test/container-memo.test.ts packages/tui/test/markdown.test.ts
    (cd packages/tui && bun run check)

To replay the independent oracle, use two separate prepared checkouts at the
pinned baseline and source commit. Copy `critic/independent.test.ts` and
`critic/phase-and-control.test.ts` to a sibling `critic` directory next to
the candidate checkout named `source`; their frozen imports are `../source`.
From that candidate checkout, run the unchanged frozen assertions:

    bun test ../critic/independent.test.ts ../critic/phase-and-control.test.ts

For baseline, change **only** that import prefix to the prepared baseline
checkout and verify the remaining test contents match the copied baseline
run-specific files. The included executed `baseline-*.test.ts` and
`candidate-*.test.ts` preserve the exact import paths used for these logs, and
`critic/baseline-receipt.txt` and `critic/candidate-receipt.txt` record their
checksums. The corresponding candidate timing invocation, from the same
checkout with the sibling `critic/benchmark.ts` imports intact, is:

    SHIMMER_HELPER_ITERATIONS=200000 SHIMMER_RENDER_ITERATIONS=10000 SHIMMER_WARMUP_ITERATIONS=10000 SHIMMER_ROUNDS=5 taskset -c 2 bun ../critic/benchmark.ts > run.json

Use the same environment variables and CPU affinity for the path-adjusted
baseline script, then alternate arms in the order frozen in
`critic/performance/run-plan.json`. The benchmark's built-in default iteration
counts are lower than the recorded plan. `critic/benchmark.ts`, its two
path-adjusted variants, run plan, analysis script, and raw JSON make the timing auditable; reruns are
environment-sensitive and should not be treated as reproducible cycle counts.

`SHA256SUMS` covers every packet file except itself. Any later publication
requires a fresh upstream and fork head/ownership check. For this source
publication, `ownership-readback/` preserves the last head/ownership responses,
and `source-readback/` preserves raw GitHub ref, commit, tree, and all three
blob responses. The verified remote ref points to
`abf7c59e76078fe7ec6ead20668f1cbe2e07d90e`, with the tested sole
parent/tree and byte-identical changed files. The independent review in
`critic/independent-review.md` predates this remote commit and remains a
historical testing receipt, not a claim that the reviewer published source.
