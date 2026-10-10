# OMP collapsed synthetic summary: grapheme-safe clipping

## Outcome and scope

At `can1357/oh-my-pi` main `1534f1a33954da73fc3c234cb0d146e6d6942f89`, the ordinary row renderer for a collapsed synthetic advisor input clips a Unicode label by iterating code points. A joined emoji can become a dangling partial sequence. The isolated feature commit `d8ecb464dc83c12ad68700fc182f9e8d9ed42a9a` (tree `f10057bd50ee1ac386269babea15d88e01598d4d`, parent exactly that main SHA) replaces this one local truncator with the repository's existing grapheme-aware `truncateToWidth` and adds one real-component regression test. The source worktree is `../source`, branch `fix/omp-synthetic-summary-grapheme-20261010`. It was clean after commit. The authorized fork feature branch was later published through the GitHub connector as commit `e5dd9aa5012095c7f722ee7199e440ec289052ee`; no PR, issue, comment, main-branch change, or upstream post was made.

Original context and credit: [#6308](https://github.com/can1357/oh-my-pi/issues/6308) was reported by @Fun10165, who proposed collapsing large advisor updates; @roboomp implemented that feature in [#6313](https://github.com/can1357/oh-my-pi/pull/6313). This patch only repairs the row renderer's Unicode clipping. No new issue was opened because CONTRIBUTING asks contributors implementing a fix not to open a parallel issue.

## Reproduction and result

The recorded run used official Bun 1.3.14 and the official OMP 18.8.8 Linux x64 native leaf. From the candidate `source` worktree, with `bun` on `PATH`, the equivalent component command is:

    bun test packages/tui/test/synthetic-summary-grapheme.test.ts

The test calls `new CollapsedSyntheticMessageComponent('# abcdef👩‍💻tail\nbody').render(11)` through the actual Disclosure/component path. The ANSI-stripped baseline row is ` abcdef👩‍…`, splitting the joined grapheme. The corrected row is ` abcdef👩‍💻t…`. The ten-cell summary budget reserves one cell for the ellipsis; the other nine fit six ASCII cells, the two-cell emoji cluster, and `t`.

- Baseline RED: `red-component.log`, exit 1, 0 pass / 1 fail.
- Candidate GREEN: `green-component.log`, exit 0, 1 pass / 0 fail.
- Independent frozen controls: `critic/baseline-component-controls.log`, 6 pass / 9 fail on a separate clean baseline worktree; `critic/candidate-component-controls.log`, 15 pass / 0 fail, 122 assertions. These are nine manifestations of the same local bug, not claims of nine unrelated defects. The frozen controls, independent review, and executable harness are included in `critic/`.
- Focused neighboring suites: `focused-neighbors.log`, 64 pass / 0 fail across the new regression, shared truncation, width parity, and native transcript; `focused-transcript.log`, 62 pass / 0 fail across committed-release and transcript-container tests.
- Package check: `tui-check-final.log`, exit 0 for `bun run check` in `packages/tui` (oxlint, oxfmt on 728 files, tsgo typecheck). `git diff HEAD^ HEAD --check` passed. Full repository tests and native rebuild were not run.

For the two setup starts that did not establish a check result: `tui-check.log` is the malformed `bun --cwd packages/tui run check` attempt that printed help and exited 0 without running the gate; `tui-check-real.log` ran lint/format, then exited 127 because the nested `bun` command was absent from PATH. The corrected package command set Bun's existing directory on PATH before `bun run check` and passed. Neither earlier attempt is counted as a pass.

## Portable replay layout

Use a sibling directory layout, with the exact published candidate and baseline checked out independently:

    <repro>/source             # kvnloo/oh-my-pi at e5dd9aa5012095c7f722ee7199e440ec289052ee
    <repro>/critic-baseline    # can1357/oh-my-pi at 1534f1a33954da73fc3c234cb0d146e6d6942f89
    <repro>/critic             # copies of this packet's two critic/*test.ts files
    <repro>/native-leaf        # official @oh-my-pi/pi-natives-linux-x64@18.8.8

The frozen critic files must be copied **unchanged** into `<repro>/critic`, not run in place within the packet. Their static imports are `../source/...` and `../critic-baseline/...` relative to that sibling directory. Keep both source checkouts at the pinned commits and verify the packet with `sha256sum -c SHA256SUMS` before copying. Set `PATH` so `bun --version` reports 1.3.14; the official Bun download/checksum receipt used for the recorded run is included as `bun-identity-source.txt`. The following are portable setup commands from `<repro>`; a fresh checkout needs its own frozen workspace dependencies, so package links resolve to the corresponding checkout:

    git clone https://github.com/kvnloo/oh-my-pi.git source
    git -C source checkout --detach e5dd9aa5012095c7f722ee7199e440ec289052ee
    git clone https://github.com/can1357/oh-my-pi.git critic-baseline
    git -C critic-baseline checkout --detach 1534f1a33954da73fc3c234cb0d146e6d6942f89
    mkdir critic native-leaf
    cp <packet>/critic/component-controls.test.ts <packet>/critic/baseline-component-controls.test.ts critic/
    (cd source && bun install --frozen-lockfile --filter '@oh-my-pi/pi-tui' --ignore-scripts && bun install --frozen-lockfile --filter omp --filter '@oh-my-pi/pi-tui' --ignore-scripts)
    (cd critic-baseline && bun install --frozen-lockfile --filter '@oh-my-pi/pi-tui' --ignore-scripts && bun install --frozen-lockfile --filter omp --filter '@oh-my-pi/pi-tui' --ignore-scripts)
    printf '%s\n' '{"name":"omp-unicode-native-fixture","private":true,"dependencies":{"@oh-my-pi/pi-natives-linux-x64":"18.8.8"}}' > native-leaf/package.json
    (cd native-leaf && bun install --ignore-scripts)
    for tree in source critic-baseline; do
      for variant in baseline modern; do
        file="pi_natives.linux-x64-$variant.node"
        ln -s "$PWD/native-leaf/node_modules/@oh-my-pi/pi-natives-linux-x64/$file" "$tree/packages/natives/native/$file"
      done
    done

Check that the installed native leaf is exactly 18.8.8 and that its lock integrity is the value below. The `.node` links are local, ignored setup, not source changes. With `bun` on `PATH`, replay from `<repro>/source`:

    bun test packages/tui/test/synthetic-summary-grapheme.test.ts
    bun test ../critic/component-controls.test.ts
    bun test ../critic/baseline-component-controls.test.ts
    (cd packages/tui && bun run check)

The third test is intentionally RED on the baseline (6 pass / 9 fail). The historical raw logs retain their original workspace-specific Bun path; the commands above are portable equivalents, not a new run in a second environment.

## Runtime and source provenance

Bun binary used for the recorded run: official Bun 1.3.14+0d9b296af, SHA-256 `9fd36f87e4b90b07632b987a2e4ec81ca15a62c81bf983190cea6d715be2ad74`; its original release archive/checksum receipt is copied here as `bun-identity-source.txt` from the separate OMP toolchain setup. This copied receipt is provenance, not a new validation performed for this packet.

Source dependencies were installed from OMP's frozen `bun.lock` using `bun install --frozen-lockfile --filter '@oh-my-pi/pi-tui' --ignore-scripts`, then root development tools using the same command with `--filter 'omp'`. npm's official `@oh-my-pi/pi-natives-linux-x64@18.8.8` platform leaf was installed separately in `../native-leaf`. Its registry and Bun-lock integrity is `sha512-8ARgRsNuR7vvAx6q6fg9o93sLIH8kuyMLv02XyZHTFWv8SqAq1RKQ7lL7n1vBZFQYeDUrs5wSw05LtJlfec7Dw==`. The package manifest names version 18.8.8 and the upstream repository; both binaries contain `PI_NATIVES_VERSION_STAMP:18.8.8\0`, and the loaded runtime reports 18.8.8. They are wired into `packages/natives/native` through ignored local symlinks, never committed. This is an official release prebuilt, not a local build or a claim of reproducible binary identity. npm metadata exposes no gitHead.

Official upstream tag `v18.8.8` is commit `1ca13863a82825bdce02908b3db9713e9b084290`. It and the tested current HEAD have identical `crates/pi-natives` tree `f245c6c5897a76dd51b5806c9cd3c6f2363d7483`, native JS tree `8b62f147475c259441e2b5db1af801fc6e5178e0`, `Cargo.lock` blob `cd5ebcac394aeab1d43f7c1610bbf5b8fa4ec289`, and `packages/natives/package.json` blob `f5db00ea6c3990f957dc75d795245f0b887fbd5e`. The repository pins Rust nightly-2026-10-06, which was unavailable here, so stable 1.97.1 was not substituted.

Committed source SHA-256: `ef3855f512a359ed954f842f2b4c1115ecb2a2d06bb7b2c347475d2cd423ebc3`. New test SHA-256: `955201afcb5feaf6a3ae0a8390288c5fdc767c9ffdc0d0029b31d512e943f2ab`. `fix.patch` is a portable export of the exact local commit. `SHA256SUMS` records all evidence file hashes.

## Independent remote readback

`critic/remote-readback/` contains the independent critic's raw, serialized public GitHub ref, commit, tree, and both changed-blob tool responses, their extracted contents, `verification.json`, and its own `SHA256SUMS`. These were read at 2026-10-10 16:32 UTC, after source publication. The critic independently verified the fork branch points to `e5dd9aa5012095c7f722ee7199e440ec289052ee`, whose sole parent is the tested upstream baseline, whose tree is `f10057bd50ee1ac386269babea15d88e01598d4d`, and whose two changed blobs match the tested local files byte for byte. `publication.json` is the implementer's earlier readback conclusion; the raw receipts supply the separate independent check.

## Ownership and follow-through

A final fresh read found upstream main still at the tested parent, fork main at `b07a1c146d0d12cfc855a2c65d52f892ef319040`, no matching open PR for “collapsed synthetic” or “synthetic summary,” and no same-named fork branch. Earlier exact file-patch review of open PRs #13927, #14910, #14499, and #10530 found no edit to `SyntheticSummary` or `truncateSummary`, though they touch `user-message.ts` elsewhere. Before any later PR or other publication, refresh heads/ownership again. OMP's `CONTRIBUTING.md` requires a contributor-written sentence in the PR body and a user-facing changelog entry with the assigned PR number and contributor credit. Neither can honestly be supplied before a PR number or human review; no placeholder entry or invented human sentence was added here. The connector-assigned Git author/committer on the published commit is Kevin Rajan, but its message explicitly identifies dot as the AI assistant that authored this patch. This is a metadata limitation of the connected Git-data path, not a claim of Kevin’s manual authorship.

The separate native `describe()` card path, the existing `Math.max(10, width - 1)` small-width overflow, SGR inserted *inside* a grapheme, terminal screenshot behavior, full-monorepo tests, and other platforms are outside this verified correction. The independent review documents these limits in more detail.
