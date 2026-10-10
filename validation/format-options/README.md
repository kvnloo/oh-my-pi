# Formatting-options redundant-scan receipt

## Scope and result

This changes only `resolveFormatOptions` in `packages/coding-agent/src/lsp/format-options.ts`. When `.editorconfig` supplies both `tabSize` and `insertSpaces`, content indentation cannot change the outgoing formatting options, so the helper no longer splits and scans the entire file. Explicit `false` counts as supplied. Partial, absent, unmatched, invalid, and inherited declarations keep their existing behavior.

The measured helper savings on five checked-in source files are **0.0055–0.8101 ms per warm request**. Their fixed paired geometric-mean helper speedup is 23.28× (95% paired bootstrap interval 22.30–24.28×). The large ratio reflects a cheap helper after removing unused work; normal absolute savings remain sub-millisecond.

| Frozen public input | UTF-8 bytes | Before (ms) | After (ms) | Saved (ms) |
| --- | ---: | ---: | ---: | ---: |
| `lsp/format-options.ts` | 4,247 | 0.008201 | 0.002686 | 0.005515 |
| `tools/write.ts` | 41,191 | 0.052890 | 0.003618 | 0.049272 |
| `tui/components/markdown.ts` | 173,784 | 0.251501 | 0.006316 | 0.245186 |
| `tui/components/editor.ts` | 193,215 | 0.293000 | 0.006370 | 0.286630 |
| `session/agent-session.ts` | 570,744 | 0.819680 | 0.009581 | 0.810099 |

The 4,194,304-byte dense-short-line **synthetic adverse case**, excluded from the primary statistic, fell from 43.978794 to 0.009491 ms. Its first baseline flatness gate failed; the no-newline 4 MB baseline already passed that gate. Both candidate flatness gates pass.

This applies to configured `lsp.formatOnWrite` and consumers invoking the formatting API. Format-on-write defaults to `false`. Actual call sites are `lsp/diagnostics.ts` and `lsp/clients/lsp-linter-client.ts`, where this helper constructs `textDocument/formatting` options. No formatting-server, full-agent, user-session, token, or memory savings are established.

## Provenance and ownership

- Public baseline: [`b07a1c146d0d12cfc855a2c65d52f892ef319040`](https://github.com/can1357/oh-my-pi/commit/b07a1c146d0d12cfc855a2c65d52f892ef319040).
- Original formatting helper and precedence contract: **roboomp**, [`2f4ba21a625e3d0351550d7c914cbbaad61afb02`](https://github.com/can1357/oh-my-pi/commit/2f4ba21a625e3d0351550d7c914cbbaad61afb02), fixing [#2329](https://github.com/can1357/oh-my-pi/issues/2329). This optimization preserves that earlier YAML indentation fix and is a separate improvement.
- Baseline helper SHA-256: `04268c3e56b1c59ec831c5562bb7d5f7cd2452e32a0f944729ce2b838c3cb132`.
- Candidate helper SHA-256: `0af08fc0cd0eb6adab9385e7b336772d3a0c0a2b18033f9706ddee84bfb99c3c`.
- Benchmark SHA-256: `6cf4da9a49d257af6bb6662756c19e9494c1b90b89e7ddbb53578c211f062780`.
- Corpus SHA-256: `4c62f2a40ce2886adbf0ba2f240d1ca7d4cd3d6e00231788332422f141bd0cfc`.
- Oracle SHA-256: `56aa5fea114f405b23bfd585b8e7f139baf7c5eed257c0aa9af68fa74275f8e5`.
- `ownership.json` records exact source/editorconfig searches and changed-file coverage for 18 open LSP-titled PRs. No relevant overlap was found. This is bounded relevant-owner coverage, not an exhaustive diff scan of every open PR.
- Project MIT licensing is unchanged. Publication is downstream-only; no upstream PR or comment is created by this receipt.

## Frozen methodology

The actual helper is imported in separate baseline and candidate processes. Five real public source inputs define the primary statistic; synthetic stress cannot drive promotion. There are 33 warm cases and 12 cold-metadata cases per process, each with nine samples. Nine alternating process pairs retain all 18 runs and 7,290 sample averages/cold observations.

`corpus.json` fixes inputs, hashes, configuration classes, membership, loop counts, and gates before candidate edits. `oracle.json` captures all five returned formatting fields from the unchanged baseline; each timed sample checks output after timing. Existing functional tests are GREEN on the baseline. The performance RED is the frozen dense-input scaling gate, not a fabricated functional failure.

Warm fixture loading, initial cache population, and warmup are excluded. GC runs before each sample, outside timing. Cold samples use a fresh parent directory for every metadata lookup; directory creation and `.editorconfig` writes are excluded. OS page caches are uncontrolled. Batch p95 in raw rows is over nine batch averages inside each process; process p95 in `results.json` is over nine process medians. Neither is an estimate of end-user p95.

Frozen gates: primary paired geometric mean ≥1.3333×; both complete-config 4 MB cases ≤5× tiny-case median +0.05 ms; every protected warm control ≤10% regression or <0.02 ms absolute; every cold control ≤10% or <0.05 ms absolute; exact formatting options preserved throughout.

All gates pass. **Measured regressions are retained**, including largest protected warm +0.002958 ms (0.53%, partial-width whitespace), worst relative tiny +2.35% (0.000072 ms, invalid config), and largest cold +0.000711 ms (missing config / 193 KB). See all ten positive deltas in `independent-audit.json`.

Whole-corpus process peak RSS medians were 247,448→258,000 KiB (**+4.26%**); ranges were 244,452–286,588 and 238,856–292,764 KiB. These processes hold the entire corpus and import dependencies. RSS is descriptive, with no transient allocation or memory-savings claim. `/usr/bin/time` was unavailable before the first launch; the successful runs use `os.wait4` per-child resource accounting, without changing helper timing intervals.

## Verification and limits

- Existing plus new formatting/spacing contracts: **29 passed**, on both unchanged baseline and candidate.
- Independent checks: **21 manual contracts / 84 calls**, **231 differential comparisons**, source review and raw-statistics audit passed.
- Changed helper, benchmark, and tests: focused TypeScript check passed through the package's `check:types` script.
- Entire coding-agent package lint and formatting checks passed (3,208 matched files).
- Diff whitespace check passed.
- **Full package/workspace types, full native-backed suite, and remote CI: HOLD.** The whole coding-agent type graph had already hit the sandbox memory limit in prior work; it was not rerun. The existing native-addon baseline is unsuitable for claiming the full native suite passed. No clean CI or merge readiness is asserted.

The published branch contains the guard, contract tests, benchmark, changelog line, and this compact receipt. Raw process results and resources are in `raw/`; all source fixtures can be reconstructed from the public baseline instead of duplicating 12 MB of source/stress data.

## Reproduce from this checkout

Requires Linux, Python 3, Git with the baseline object available, and an already working Bun workspace with its normal dependencies/native addon. The resource coordinator uses Linux affinity, `/proc` load readings, and Linux `ru_maxrss` KiB units. Recorded runtime: Bun 1.4.2. Run from the repository root:

```sh
OUT=$(mktemp -d)
python3 validation/format-options/materialize.py "$OUT"
python3 "$OUT/run-replications.py"
python3 "$OUT/summarize.py"
bun test packages/coding-agent/test/lsp-format-options.test.ts \
  packages/coding-agent/test/lsp-format-options-overrides.test.ts \
  packages/utils/test/spacing.test.ts
bun run --cwd packages/coding-agent check:types \
  --project "$(pwd)/validation/format-options/tsconfig.focused.json"
```

`materialize.py` refuses to overwrite a nonempty directory, validates every fixture byte count/hash, and copies the identical benchmark beside the exact baseline helper. The portable runner differs from the recorded coordinator only in resolving the checkout and Bun paths. Keep other CPU-intensive builds stopped during timing. All runs are retained; failures stop the runner rather than being discarded.
