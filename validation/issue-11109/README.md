# Independent validation of OMP issue #11109 / owner PR #11111

Credit: szavadsky reported the flaky wall-clock assertion; roboomp authored the scalar-counter fix in [PR #11111](https://github.com/can1357/oh-my-pi/pull/11111). This branch validates that existing fix downstream. It is not a competing implementation and does not change production parser code.

Current main `46ad32961a96aef21cd35fe615374f4b3675ca58` already uses a 6-second wall-clock ceiling and 30-second test deadline. Owner head `f2d0c3564a3c463a726e93aaab2c243d8e30d048` has a scalar `peek` wrapper, not the earlier allocating spy. The exact owner test body and import are transplanted onto current main; the obsolete main timing comments disappear. The upstream PR remains open, unmerged, and dirty.

## Result

- Main baseline, transplanted test, and original owner dependency closure each pass 23 tests / 137 assertions.
- Combined incoming-json / json-parse suite passes 46 tests / 191 assertions.
- Package check passes: oxlint, oxfmt (227 files), and tsgo. Minimal official registry tools plus tracked native declarations were used; no full native/workspace build was run.
- At 5k / 10k / 20k, scalar reads are exactly 210,019 / 420,019 / 840,019, or `42*n+19`, in all 15 fresh-process samples per size.
- A bounded rescan mutant at 128 / 256 / 512 preserves sum/exhaustion but makes 200,467 / 794,131 / 3,161,107 reads. It fails the `<250*n` bound, with approximately quadratic growth and no per-call mock history.
- The original prototype is restored after successful runs, read-bound failure, and injected mid-loop failure.

## Timing protocol and interpretation

Before measurements, the harness was frozen and formatted. Ninety fresh Bun 1.4.2 processes were run, 15 per mode/size, interleaving plain/scalar order with no warmup. Wall time covers document setup and the awaited loop, not process startup. Nearest-rank p95 is reported. Known team builds/tests were held from 01:38:04 to 01:38:23 UTC on 2026-10-10; unrelated shared-host activity cannot be excluded.

| Elements | Plain median / p95 (ms) | Scalar median / p95 (ms) |
| --- | --- | --- |
| 5,000 | 64.72 / 75.54 | 61.11 / 77.35 |
| 10,000 | 145.04 / 183.00 | 152.25 / 194.50 |
| 20,000 | 368.73 / 396.81 | 381.06 / 462.30 |

These are descriptive test-instrumentation overhead measurements on the same current-main algorithm. They do not establish a parser runtime speedup or token improvement. Plain runs intentionally have no operation counter; their operation counts are unmeasured. The scalar mechanism itself retains only an integer and saved method, not a record per call.

The 30-second deadline remains a wall-clock liveness guard and can still fail under extreme contention. `peek` reads guard lexer work for this fixture, not every possible regression. The temporary prototype wrapper may also count concurrent unrelated lexer work; restoration does not establish isolation against arbitrary concurrent execution.

## Reproduce

Use Bun 1.4.2 and current-main sources. Run the focused test and package check through the repository's documented commands. From the repository root:

```
bun test packages/utils/test/incoming-json.test.ts packages/utils/test/json-parse.test.ts
python3 validation/issue-11109/run-samples.py --bun /path/to/bun --output samples.json
python3 validation/issue-11109/check-mutant.py --bun /path/to/bun --output mutant.json
bun validation/issue-11109/scan-harness.ts 20 scalar failure
```

The mutation script changes temporary copies only. `receipt.json` records source hashes, exact sample count, tool/runtime provenance, check outcomes, and bounded mutation evidence. Full sample data is retained locally with its SHA-256 in the receipt; raw environment logs are not published.

## Actionable owner review

The current scalar patch addresses the earlier allocating-spy review. Rebase the owner branch onto current main, retaining the scalar wrapper and `finally`, and remove the current-main 6-second assertion. The downstream transplant passes the focused checks. The upstream PR body still describes a spy and a previous 2-second main ceiling; update those descriptions to reflect the latest scalar implementation and current baseline. Keep the limited 30-second liveness caveat, rather than claiming no loaded runner can ever fail.
