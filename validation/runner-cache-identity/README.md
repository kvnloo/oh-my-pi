# Runner staging identity validation

Base: `can1357/oh-my-pi` at `b07a1c146d0d12cfc855a2c65d52f892ef319040`.
Branch: `kvnloo/oh-my-pi:fix/omp-runner-cache-identity-20261010`.
Validation date: 2026-10-10 UTC. Runtime: Bun 1.4.2 (`744846f84`), Linux, non-root. Output receipts normalize checkout paths and trailing whitespace.

## Finding and bounded fix

The exported `stageRunnerScript(dirName, ext, script)` helper used only `dirName` to identify its warm memo. A later call in the same process with different source returned the original executable; a changed extension returned the original filename. The on-disk cache already includes the source hash and extension in its identity.

Warm reuse now requires that existing filename identity before the unchanged private-directory and existence checks. One memo slot per directory, hash-based on-disk names, deleted-file restaging, predictable-directory validation, and private fallback staging are retained. This does not expand cache lifecycle or add dependencies.

The three shipped callsites use constant source assets and extensions. The evidence establishes the exported helper's changed-input contract, not a common shipped-CLI incident. Source hashing now occurs on warm calls; no performance improvement is claimed. Existing hash-collision, content-integrity, and check-to-use race boundaries are unchanged.

Related work and credit: [@rhlsthrm](https://github.com/rhlsthrm) reported deleted-runner recovery in [#8140](https://github.com/can1357/oh-my-pi/issues/8140), and [@roboomp](https://github.com/roboomp) fixed it in [merged #8141](https://github.com/can1357/oh-my-pi/pull/8141). That completed fix is preserved; this source/extension identity defect is distinct.

## Ownership

Fresh issue and PR searches found no open `stageRunnerScript` owner. The five incidental open PRs from the `runner-cache` search (#10019, #10849, #12059, #14401, #13203) were checked against actual changed-file lists; none modifies the helper or its regression test. The actual #8141 diff handles missing files, not changed source or extension. Upstream main still matched the base immediately before publication.

## Frozen RED and GREEN

The existing suite passed 6 tests / 19 assertions before new tests were added. The new tests were frozen before the production edit:

- RED on unchanged production: 6 pass, 2 expected failures. Executing the requested updated source printed `original`; requesting a TypeScript extension returned `.js`. See [red.txt](red.txt).
- GREEN after the minimal edit: the same test file passed 8 tests / 24 assertions, including the six existing reuse, deletion, symlink, and private-directory controls. See [green.txt](green.txt).
- Frozen test SHA-256: `163ccc44fad36190e01a34869abf0ea98b05c86c58bcb05958dede6fbe210d56`.
- Reviewed helper SHA-256: `fce74606ac30122c326f1b1f2268d6037218a43793a3d77c72a603c6f808a07a`.

Tests import the production helper and execute real temporary runners with Bun; there are no module mocks or source-text assertions. To reproduce RED, use a separate checkout of the base, copy only the candidate regression test into it, and run the command below. Keep the candidate helper unchanged for GREEN.

```sh
bun test packages/coding-agent/test/runner-cache-restage.test.ts
```

## Independent review

Independent review promoted the bounded helper-contract fix with no implementation changes. The reviewer reran the frozen suite (8 tests / 24 assertions) and ran [nine additional probes](independent-probes.test.ts) (9 tests / 50 assertions): A→B→A source/extension identity, equal-content inode/mtime reuse, distinct directory keys, file-only deletion, overlapping requests, permission normalization, symlink replacement/private fallback, and the owner-private guard matrix. The foreign-owner matrix uses synthetic stat values, not an actual foreign-owned directory. See [independent-probes.txt](independent-probes.txt).

```sh
bun test validation/runner-cache-identity/independent-probes.test.ts
```

## Checks and limits

Status: the bounded fix is independently reviewed. The actual **full coding-agent package typecheck passed** on the exact published source tree `c47e7dfd01e16bfa81aa2e991af408b2726a4a95` after memory cleanup. The earlier resource-blocked attempts remain historical evidence. Full-workspace checks, the full test/native suites, and hosted CI remain separate unverified stages; **hosted CI HOLD** remains. This is not a merge-ready claim.

- `git diff --check`: passed.
- Package lint passed; formatting passed across 3,206 matched files.
- The first full coding-agent package check was SIGKILLed during typechecking (exit 137); it did not pass. See [initial-package-check.txt](initial-package-check.txt).
- Focused typechecking of the helper, owner-private dependency, frozen test, and asset declarations passed through the documented package entry with `GOMAXPROCS=2`, `GOMEMLIMIT=512MiB`. This is a focused check, not the full package gate. See [focused-typecheck.txt](focused-typecheck.txt) and [tsconfig.focused.json](tsconfig.focused.json).
- The second exclusive full-package typecheck attempt was also SIGKILLed (shell exit 137) after 40.55 seconds with `GOMAXPROCS=2` and `GOMEMLIMIT=512MiB`. Peak child RSS was 3,499,956 KiB. The 180-second timeout and 600-MiB host-availability safety guard did not trigger; no type diagnostics preceded the kill. The gate did not pass in that attempt. See [final-full-typecheck.txt](final-full-typecheck.txt) and [resource receipt](final-full-typecheck-resources.txt).
- A later independent, exclusive full-package run of `GOMAXPROCS=2 GOMEMLIMIT=2GiB bun run check:types` **passed, exit 0**, in 43.06 seconds (05:14:25–05:15:08 UTC). It executed the actual `tsgo -p tsconfig.json --noEmit` package script without a narrowed project or configuration override. The clean local checkout at `8ea36482a2f6fdcb46cb512f89b58d4490781a85` had the same complete tree as published `df9aedccee5d47dd26df33990971811bf1edfdf3`; before/after snapshots, source hashes, and status were unchanged. Peak child RSS was 4,185,312 KiB. `GOMEMLIMIT` is a soft Go runtime target, not a total-RSS ceiling. See [PASS output](full-typecheck-pass.txt) and [sanitized result](full-typecheck-pass-result.json).
- No Windows execution, native/Rust rebuild or full suite, full-workspace check/tests, package build, hosted CI, or end-to-end CLI workflow was performed. Earlier package lint/format and frozen/independent tests are separate prior executions, not newly rerun by the typecheck verifier.

```sh
cd packages/coding-agent
GOMAXPROCS=2 GOMEMLIMIT=512MiB bun run check:types -- -p ../../validation/runner-cache-identity/tsconfig.focused.json
# Later independent full-package PASS, after memory cleanup:
GOMAXPROCS=2 GOMEMLIMIT=2GiB bun run check:types
```

This fork branch is a review handoff. No upstream issue, PR, or comment was created for this patch. An upstream contributor PR still requires the contributor's own explanation, human review, and PR-number changelog attribution.
