# Downstream experiment: bounded generic AWS rendering

This branch evaluates the allocation cleanup reported by [MikeeI in upstream issue #7419](https://github.com/can1357/oh-my-pi/issues/7419). [roboomp's triage](https://github.com/can1357/oh-my-pi/issues/7419#issuecomment-5160946228) leaves implementation to a maintainer acceptance decision. This is a downstream experiment, not an upstream-ready submission or a claim that acceptance was granted.

The generic fallback originally recursively cloned/pruned every JSON value, then deep-cloned every object row, before rendering at most 40 rows. The candidate borrows those rows and excludes sensitive keys during array/column selection. Specialized service formatters and the shared cell formatter are unchanged. Objects render as the same constant `{...}`; arrays render their outer length, which recursive key pruning never changes.

## Frozen evidence

Baseline source: upstream main `46ad32961a96aef21cd35fe615374f4b3675ca58`, current when inspected on 2026-10-10 UTC. The checkout was clean before an isolated branch was created. The pre-existing incoming-JSON validation worktree was not edited.

`frozen-output.json` was captured before candidate edits. SHA256:
`51ef0ba4b6b59738406f1d3ad8aee98ab6d23102f07f5aca25a14738313793dd`

Twelve deterministic synthetic cases protect exact generic output and public cloud-filter output. They include top-level sensitive arrays, case-sensitive key matching, empty and mixed arrays, sensitive-only rows, nested sensitive objects and arrays, six-column selection, columns discovered after row 40, object-only elision counts, and unchanged passthrough when no generic table can be rendered. No actual AWS account or secret data is used.

The allocator regression calls the actual `compact_aws_generic` after fixture construction/parsing, and counts allocation requests plus cumulative bytes requested from the system allocator (including reallocations). It is not peak RSS, live heap size, or an inferred operation count. The fixture has 1000 rows, 1,025,024 total unrendered payload bytes, and a 548-byte output. The frozen limit is 262,144 cumulative requested bytes.

- Baseline: 4,861,047 cumulative requested bytes, 35,191 allocation requests. `regression` fails with exit 101 (see `red.log`).
- Candidate: 38,678 cumulative requested bytes, 3,182 allocation requests. Same output; `regression` passes (see `green.log`).

The candidate still allocates a borrowed-row pointer vector and scans row keys for late-discovered columns. This is a narrow clone removal, not constant-memory streaming or a change to capture/parsing costs.

## Reproduce

Python 3, Cargo/Rust, and cargo-nextest are required. Each run generates an isolated temporary package. The exact production `cloud.rs` and `primitives.rs` are read from the working tree or `--ref`, with only their first inner-doc comment converted to a normal comment for inclusion. A measurement-only wrapper exposes the private generic function. No production code is reimplemented. The unused config/context/output façade in `harness.rs` is minimal and does not exercise full shell dispatch, runtime wiring, or N-API integration.

From the repository root:

```sh
python3 validation/omp-7419/run.py regression --ref 46ad32961a96aef21cd35fe615374f4b3675ca58
# Expected allocation-budget failure, after exact frozen-output parity passes.
python3 validation/omp-7419/run.py regression
python3 validation/omp-7419/run.py tests
python3 validation/omp-7419/run.py lint
python3 validation/omp-7419/run.py bench --ref 46ad32961a96aef21cd35fe615374f4b3675ca58
python3 validation/omp-7419/run.py bench
```

Use `--offline` only when the locked dependencies are cached. Cargo and CARGO_TARGET_DIR select the toolchain and build target normally. The test runner uses nextest, following the repository's Rust-test convention. Run the normal repository `bun run test:rs` and `bun run check:rs` separately for full-workspace verification.

The benchmark warms each scenario, takes 31 samples of 10 operations, and reports both the actual private generic fallback (parse excluded) and public cloud filter (parse included). Synthetic cases are 10 small rows, 1,000 rows with approximately 1 MiB total ignored payload, and 4,000 rows with approximately 2 MiB total ignored payload, each below the default 4 MiB capture cap. It reports real timings only; no model latency, provider cache, token, or cost savings are claimed.

## Ownership and attribution

Live issue/comment and PR searches found no implementation of #7419, `prune_aws_sensitive`, or this generic clone removal. Original minimizer work by GratefulDave in #1638/#2041 was closed/superseded. H4vC's merged #14454 changes in the same file are psql-specific; its inspected file diff does not overlap this generic AWS change. Existing authorship and MIT notices are preserved. Ownership is evidence at inspection time, not a promise that other work cannot start later.

Do not open an upstream PR or comment from this experiment. Upstream readiness remains on hold for maintainer acceptance and human review, including the contributor's own explanation required by CONTRIBUTING.md.

## Timed experiment and limits

Four prebuilt process runs used ABBA order: baseline, candidate, candidate, baseline. The quiet window was coordinated with other work and all samples completed from 2026-10-10 02:01:09.404812 through 02:01:53.133282 UTC (43.73 s), pinned to CPU 0. Each process runs all three cases, warming each path 10 times before 31 samples of 10 calls. Thus each variant/path has **62 within-process batch samples across two process runs**, not 62 independent process replications. Raw block samples and the descriptive combined medians are in `timings/` and `timing-summary.json`.

Compiler: rustc 1.98.1 (48a229cea 2026-09-01), Cargo 1.98.1. Standalone Cargo **default release** settings (opt-level 3, default codegen units, no fat LTO), distinct from the repository's shipping release profile. Dependencies are frozen in the included Cargo.lock; serde_json 1.0.151 uses `preserve_order` as the production workspace does. The counting allocator stays installed during timing with counting disabled, leaving one atomic flag load per allocation. Allocation-heavy baseline timings therefore include instrumentation overhead. These numbers describe this instrumented isolated harness only.

| Object rows | Input JSON bytes | Generic baseline → candidate | Public filter, parsing included, baseline → candidate |
| --- | ---: | ---: | ---: |
| 10 | 1,790 | 14.912 → 2.106 µs | 42.493 → 24.319 µs |
| 1,000 | 1,166,952 | 1,817.364 → 104.575 µs | 7,567.297 → 5,835.669 µs |
| 4,000 | 2,619,440 | 7,332.330 → 411.198 µs | 26,686.960 → 17,160.183 µs |

The 1,000-row public-filter median is 22.9% lower in this harness. This is not a shipping-binary, full-shell, session, provider, model-latency, token, or cost result. The deterministic reduction in cumulative allocation requests/bytes for unchanged capped output is the stronger evidence.

Baseline executable SHA256: `33ce6aefa95ef10e7e1e15927d1633f3f74bf7ac1ae860b6722480ae119636ac`.
Candidate executable SHA256: `213545a558e4ad7c202f80cd55309cb10dfefb744d35f4a1225f44d987259af7`.
The timed candidate was built after the production change; later source additions were only `#[cfg(test)]` contract tests and documentation, excluded from this release build.

Exact-source cloud/primitives nextest: 43 passed, 0 skipped, including the two new filter contract tests. This is module-level coverage through the disclosed façade, not full-workspace coverage. The pinned nightly full-workspace check/test scripts are tracked separately; their status is not inferred from this focused pass.

Full-workspace attempt history: the initial `bun run check:rs` passed rustfmt, then was interrupted with exit 130 to relieve shared-resource pressure. The initial `bun run test:rs` downloaded dependencies and waited for that build-directory lock, then was also interrupted with exit 130. Those attempts did not pass; their raw logs remain preserved locally and their results/hashes are recorded in `gate-results.json`. Subsequent gates run serially with `CARGO_BUILD_JOBS=2`. The initial missing-nextest blocker was resolved using official cargo-nextest 0.9.148 with its release checksum verified.

A fresh 2026-10-10 ownership/base check found upstream main at `b07a1c146d0d12cfc855a2c65d52f892ef319040`, eight commits after the measured base. The upstream compare lists only selector-dashboard and TUI observer/hub changes: neither `cloud.rs` nor the natives changelog changed. The measured base is intentionally retained for this bounded experiment. The issue still had only the maintainer-deferral comment. Searches for #7419 on both repositories found no implementing PR; every open PR from the broader AWS/generic query was file-listed, with no source/changelog overlap.

An independently rebuilt differential probe passed 3,181 adversarial fixtures and 34,991 exact comparisons. It covers all 15 sensitive keys at depths 0–7, case variants, mixed rows, row boundaries, late six-column discovery, and 3,000 seeded heterogeneous JSON cases. It compares the actual generic function and public filter text/changed/byte metadata under five command contexts and both success/failure exit codes. The reviewed production source SHA256 was `d9cbd2c6fa130898cb33d15061bafcfef55ec1069e92647f2f77f6e3eeeb9490`. The unchanged frozen parity and allocation RED→GREEN were also independently rebuilt/replayed. This supports the bounded experiment; full-workspace and upstream acceptance gates remain separate.

Reproduce the differential probe without checked-in production-source copies:

```sh
CARGO_BUILD_JOBS=2 python3 validation/omp-7419/run.py differential
```

This reads baseline source from the stated pinned Git revision and candidate source from the current tree (or `--ref`), compiling both exact modules into one isolated package. `differential.log` records the completed independent replay; no timing claim comes from the differential run.

Provenance: the 12-case oracle bytes and allocation budget were frozen locally before production edits. The two Git commits are assembled afterward: the first records that previously frozen evidence, and the second records the implementation and completed validation. This does not assert that a baseline Git commit existed before the experiment. Original timed `timed-harness.rs` SHA256 is `b07ce047e1ccbd92023ee06a0b77405f56cc767ead5a50c66dd040c7d036d29b`; it remains separate from the lint-clean validation façade. Strict module Clippy (`-D warnings`, all targets) passed after correcting only the façade's unused config shape and placement of the measurement wrapper before tests. Production source was unchanged by those lint corrections.

The bounded full-check target was moved from tmpfs to disk after checking free space. A disk-backed retry terminated with exit 101 because the unrelated `wasmtime-c-api-impl 29.0.1` build script could not spawn `cmake` (binary absent). See the portable attempt receipt in `gate-results.json`; raw build logs are retained locally. This was an environment failure, preserved alongside the resource-pressure and tmpfs interruptions.

The missing-tool blocker was addressed with scoped PyPI installations of CMake 4.4.4 and Ninja 1.13.2, without global configuration changes. The retry uses those verified binaries on PATH, two Cargo jobs, and the disk-backed target. The original missing-cmake failure remains evidence of that attempt; it is not relabeled a pass.

Final full-check result: `CI=1 CARGO_BUILD_JOBS=2 bun run check:rs` **passed, exit 0**, under the repository-pinned `nightly-2026-10-06` (rustc 1.101.0-nightly), with the scoped CMake/Ninja binaries and disk-backed target. This ran the normal repository rustfmt check and workspace Clippy/typechecking with `-D warnings` (the script excludes its documented vendored forks). Locally retained raw pass log SHA256: `505acafddb22d0fc477006a2fb27aab6e783af35c9be7755f542f6450433e09b`. This successful retry supersedes the earlier check blocker without changing those historical attempt outcomes. The terminal full-test result and actual baseline comparison are recorded below.

Artifact hygiene: full raw build logs are retained locally, not checked in. `gate-results.json` records portable commands, terminal outcomes and their raw-log hashes. Focused module logs replace temporary workspace paths with `<validation-workspace>`. Synthetic fixture/measurement bytes and source hashes are unchanged.

Final full-test result: `CI=1 CARGO_BUILD_JOBS=2 NEXTEST_TEST_THREADS=2 CMAKE_BUILD_PARALLEL_LEVEL=2 bun run test:rs` **failed, exit 100**. Nextest ran 3,279 tests across 33 binaries: 3,268 passed, 11 failed, 6 skipped. The script stopped at nextest and did not execute its doctest phase. Nine failures concern Wayland/OAuth/VFS socket/setup operations denied by this sandbox (including two secondary assertions); two concern pi-walker parent-ignore behavior. The normal full-workspace test gate is not reported as passing. Locally retained raw log SHA256: `4029721ad1cdf3b9b03557294cfbff8d466db4dd6383fd1be6dcfc9389d0539c`.

All eleven test identities were then selected and actually executed from a separate clean checkout of exact baseline `46ad32961a96aef21cd35fe615374f4b3675ca58`, with the same pinned nightly, test profile, sandbox, scoped tools, locked dependencies and jobs/thread limits. Cargo rebuilt baseline pi-shell/napi/pi-natives source and reused unchanged dependency artifacts where valid. **All 11 failures reproduced**, exit 100, with the same assertion/EPERM signatures; none passed. The failed modules, manifests and build inputs are source-identical, with SHA256 evidence in `gate-results.json`. This comparison isolates the baseline failures; it does not mask them or convert the full test gate to a pass.

Exact-head focused workspace nextest then **passed all 43 cloud/primitives tests**, including both added AWS contracts, using the normal workspace package set/feature graph and pinned nightly. Its explicit test filter excluded 3,242 other tests. This runs the real pi-shell crate rather than the isolated measurement façade. See `exact-head-test-results.log` and the raw-log hash in `gate-results.json`. An unfinished first focused attempt used only `-p pi-shell`, which triggered a reduced-feature dependency rebuild; it was interrupted (exit 130, not a pass) and replaced with the normal workspace package set. The baseline failures were not retried toward success.

The normal script doctest phase was executed separately and **passed, exit 0**: one runnable tree-sitter-go example passed, 18 examples were ignored, and pi-natives cdylib doctests are unsupported. Its portable command and raw-log hash are in `gate-results.json`. The original combined `bun run test:rs` remains failed; focused tests and separate doctests do not change that result. An existing pi-builtins test-only non-snake-case warning appeared during test compilation; the normal production workspace `check:rs` passed with its prescribed `-D warnings` scope.

The final pre-publication ownership recheck at 2026-10-10 02:47 UTC found the same sole maintainer-deferral comment, no implementing PR for #7419 or `prune_aws_sensitive`, and only the previously inspected closed #1638 for `compact_aws_generic`. Upstream main remained `b07a1c146d0d12cfc855a2c65d52f892ef319040`; the intended downstream branch name was absent.
