# Exact-tree publication audit

The reviewed source change is qualified for the requested downstream feature branch. No upstream PR or other upstream publication is approved or performed by this review.

## Immutable source identity

- Local source commit: `d8ecb464dc83c12ad68700fc182f9e8d9ed42a9a`
- Reviewed tree: `f10057bd50ee1ac386269babea15d88e01598d4d`
- Exact sole parent: `1534f1a33954da73fc3c234cb0d146e6d6942f89`
- Production blob: `1132033e2d1df1b96bbd91b1d067a6b237139a91`
- Regression-test blob: `4cf42ae64001ebf3c984f98d3b918a633ca018e5`
- Production SHA256: `ef3855f512a359ed954f842f2b4c1115ecb2a2d06bb7b2c347475d2cd423ebc3`
- Regression-test SHA256: `955201afcb5feaf6a3ae0a8390288c5fdc767c9ffdc0d0029b31d512e943f2ab`

The commit contains exactly two changed files (+17/-16): existing shared-helper reuse in `user-message.ts`, removal of its duplicate truncator, and one public-component regression test. Worktree clean. No formatting churn, lockfile changes, dependencies, generated files, or unrelated cleanup. `git diff --check HEAD^ HEAD` passed. The production bytes remain identical to the independent 15-case tested candidate.

`fix.patch` SHA256 `2c940110e02dcf97b699e768a5569e97ae0a8c0ff5a2eace655b69f7ff716011` independently passes `git apply --check` in the clean baseline worktree.

## Terminal gate receipts reviewed

- Independent real-component candidate: 15/15 pass, 122 assertions; clean baseline 6 pass/9 fail.
- Focused neighbors: 64/64 pass, 101 assertions, four files; log SHA256 `dd0a0aead1d48f2c486029713fb46468ff17eb5cbe9a1fc4135691c1edb8dd86`.
- Transcript neighbors: 62/62 pass, 230 assertions, two files; log SHA256 `a48bfcee6e651660d0829e83d2a314a78edea3bddd8a1a0fce82b38f85d11c78`.
- Full TUI package check: oxlint, oxfmt across 728 files, then tsgo; exit 0. Log SHA256 `cab35538e2cde9ad2c2429dfdd2f65a8867af4d328c2c9cda2ff76079bd7cc6c`.

The earlier usage-only exit 0 is not counted as a gate pass. The separate missing-Bun-on-PATH exit 127 is also retained as a setup failure, followed by the corrected passing invocation.

## Provenance, credit, and limits

The local source commit explicitly credits Fun10165's original advisor transcript report/design in #6308 and roboomp's collapsed-summary implementation in #6313. It identifies this correction as fallback row rendering. The original feature is not claimed as this patch's invention.

The native runtime is the official 18.8.8 prebuilt. Source equivalence with the release tag is independently checked, including all Rust crates, root Cargo configuration, native package manifest, generated JS interface and Cargo.lock. This is not an independently compiled native addon or reproducible-binary attestation. No full-monorepo suite, running-terminal screenshot, platform matrix, narrow-width overflow fix, or ANSI-internal grapheme guarantee is claimed.

The source remains downstream-only. Any later upstream PR still requires the repository's human review/written explanation and correctly attributed changelog workflow.

## Evidence packaging qualification

The portability issue was corrected. The README now uses Bun on PATH and provides an explicit `<repro>/{source,critic-baseline,critic,native-leaf}` layout. Preserved critic harnesses are copied unchanged into the sibling `critic` directory so their static imports resolve correctly. Fresh frozen dependency installation is documented per checkout; native leaf installation and ignored symlinks are explicit. The referenced Bun identity receipt is included. These are inspected replay instructions, not a claim of a second fresh-environment replay.

The corrected original packet's 18 checksum entries and evidence-branch packet's 19 entries all independently verified. README SHA256: `7ae767d9eeb5b598b4e436e85575d1c0d29f207ab6919e9fdabb6385565c76bd`. Bun provenance receipt SHA256: `416f5dba4a8c5d7128f74a53cd5333d5373a79871f6e58a8da8fe4cd4a890cf4`. Frozen harness copies are byte-identical to the previously tested files.

The additional independent remote readbacks and this final audit should be included with a regenerated hash manifest before publishing the evidence branch. The existing evidence content is qualified; these additions are new receipts, not code changes.

## Independent published-source readback

At 2026-10-10 16:32 UTC the critic independently read the public fork's branch ref, Git commit, root tree, and two changed blobs using read-only GitHub connector requests. Complete serialized tool responses and their exact returned content are saved in `remote-readback/`, together with a hash manifest and machine-readable `verification.json`.

- Public source branch: `https://github.com/kvnloo/oh-my-pi/tree/fix/omp-synthetic-summary-grapheme-20261010`
- Exact published commit: `e5dd9aa5012095c7f722ee7199e440ec289052ee`
- Published tree: `f10057bd50ee1ac386269babea15d88e01598d4d`, identical to the reviewed local tree.
- Published sole parent: `1534f1a33954da73fc3c234cb0d146e6d6942f89`.
- Every returned root-tree entry matches local `git ls-tree HEAD` exactly; remote response is not truncated.
- Both returned blob contents compare byte-for-byte identical to the tested source and test. Recomputed Git blob hashes and SHA256 values match the identities above.
- Published commit message explicitly says `Authored by dot (AI assistant)` and credits Fun10165 and roboomp. Connector-assigned Git author/committer metadata names Kevin Rajan; this does not claim manual human authorship. The local export preserves the explicit dot author metadata.

Verdict: the exact published downstream source tree and corrected portable evidence content meet the reviewed narrow correctness scope. No extra tests or source changes were needed after the immutable-tree check. No upstream writes were performed by this critic.
