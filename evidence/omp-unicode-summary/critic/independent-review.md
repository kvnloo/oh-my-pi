# Independent review: collapsed synthetic-summary Unicode clipping

## Verdict

The narrow correctness fix is independently verified on the real public `CollapsedSyntheticMessageComponent.render()` path. The candidate replaces a duplicate code-point loop with the existing shared `truncateToWidth` helper. It preserves complete grapheme clusters at the tested clipping boundaries and preserves the existing ASCII/CJK/fallback behavior. No candidate-source changes were made by this critic.

## Revisions and isolation

- Upstream baseline: `1534f1a33954da73fc3c234cb0d146e6d6942f89`.
- Baseline `packages/tui/src/chat/user-message.ts` blob: `f9d4263e31705bf15ae946130376d3c1a0af5baa`.
- Baseline source SHA256: `1b30966f26c18d28f67c49a2aaf976e8e9e53d1eb73852e3ecf103547611161f`.
- Tested candidate source SHA256: `ef3855f512a359ed954f842f2b4c1115ecb2a2d06bb7b2c347475d2cd423ebc3`.
- Independent controls were frozen before the candidate existed. The initial supplied example omitted a fitting `t`; source-only review corrected that expected string before candidate inspection. Both versions are preserved in `frozen-controls.md` (SHA256 `5df68c9caa4087f582d06dda6ad3a01b4328829d725a07583e1ff89a17a990b8`).
- Independent executable harness SHA256: `ddcbd4d4949d7475a9b339598fde467e382be8437b19ef4c2a4b246a0740d00c`.
- RED used a separate clean detached worktree, `../critic-baseline`, checked out at the exact baseline. Runtime dependencies were shared through symlinks, with local workspace package symlinks preserved so baseline package imports point to baseline sources. `git status --short` in the baseline worktree was empty. The baseline harness differs only in its two static import paths.

## Actual runtime results

Using Bun 1.3.14 (`0d9b296a`) and the release-native setup described below, from the candidate source directory:

```
../../omp-perf/toolchain/bun-linux-x64/bun test ../critic/component-controls.test.ts
# 15 pass, 0 fail; 122 assertions; exit 0

../../omp-perf/toolchain/bun-linux-x64/bun test ../critic/baseline-component-controls.test.ts
# 6 pass, 9 fail; 53 assertions; exit 1
```

Full receipts: `candidate-component-controls.log` and `baseline-component-controls.log`.

The concrete original regression:

```
new CollapsedSyntheticMessageComponent('# abcdef👩‍💻tail\nbody').render(11)
```

ANSI-stripped baseline: ` abcdef👩‍…`

ANSI-stripped candidate: ` abcdef👩‍💻t…`

The leading space occupies one column. The ten-column summary budget reserves one column for the ellipsis, leaving nine for `abcdef` (six), `👩‍💻` (two), and `t` (one).

Candidate passes cover:

- ZWJ technologist and family emoji at five nearby clipping widths.
- Emoji skin-tone modifier, regional-indicator flag, combining accent, emoji variation selector, keycap, and CJK boundary controls.
- Complete SGR sequences around clipped text, with identical visible output to the corresponding plain heading.
- Fixed ASCII and CJK expectations, untruncated statistics, and empty/no-heading fallback input.
- Resize down/up, repeated-width caching, invalidation, cache release, actual expanded body rendering, and collapse again.

Additional observed baseline failures include half a flag, dropped skin tone, incomplete keycap, and VS16 sequence cell-width overflow. Plain combining accents, ASCII, CJK, fallback input, and the existing narrow-width behavior pass the corresponding controls on both revisions.

## Native runtime provenance review

This review used the separately installed official npm platform leaf `@oh-my-pi/pi-natives-linux-x64@18.8.8`, not a native addon built by this review. The installed manifest names that exact version and the upstream repository. Its Bun lock records:

```
sha512-8ARgRsNuR7vvAx6q6fg9o93sLIH8kuyMLv02XyZHTFWv8SqAq1RKQ7lL7n1vBZFQYeDUrs5wSw05LtJlfec7Dw==
```

The modern binary contains `PI_NATIVES_VERSION_STAMP:18.8.8` at byte offset 18765132. The implementer separately reports runtime version 18.8.8 and registry-integrity verification; the critic independently checked the installed manifest, lock, binary marker, and local Git comparisons below.

Official release tag `v18.8.8` resolves locally to `1ca13863a82825bdce02908b3db9713e9b084290`. Independent `git rev-parse` comparisons show these trees/blobs identical at the tag and tested baseline:

- `crates/pi-natives`: `f245c6c5897a76dd51b5806c9cd3c6f2363d7483`
- `packages/natives/native`: `8b62f147475c259441e2b5db1af801fc6e5178e0`
- `Cargo.lock`: `cd5ebcac394aeab1d43f7c1610bbf5b8fa4ec289`
- `packages/natives/package.json`: `f5db00ea6c3990f957dc75d795245f0b887fbd5e`

`git diff --stat v18.8.8 HEAD -- Cargo.toml rust-toolchain.toml .cargo crates packages/natives` is empty. This also covers the native crate's workspace dependencies and build configuration, beyond the directly changed helper. No npm gitHead or reproducible-build attestation was available; matching public release lineage is not a claim of independently rebuilt binary identity.

## Limits and scope

- This verifies the row-rendering path, including its real Disclosure and expanded body. It does not verify a running terminal screenshot or the separate native `describe()` card path.
- The existing `Math.max(10, width - 1)` summary floor still makes widths 0, 1, and 10 render an eleven-cell row. Both baseline and candidate exhibit this, and it is explicitly excluded from this fix.
- The shared helper segments contiguous non-ANSI runs. ANSI inserted inside a Unicode grapheme is a source-level limitation not exercised or claimed solved here; ordinary SGR wrapping is exercised.
- No native build, whole-monorepo suite, or platform-wide validation is claimed. Implementer owns adjacent lint/type/test gates after this replay.
- Original collapsed-summary feature provenance should credit Fun10165's issue #6308 and roboomp's PR #6313. This new Unicode clipping regression is not a claim to have independently authored that original feature or to resolve the already-handled performance report.
- This critic did not publish, push, post comments, or open an upstream PR.
