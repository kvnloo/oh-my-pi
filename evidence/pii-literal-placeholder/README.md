# Literal PII placeholder repair

**LIMITED:** complete-source registered handler evidence under Node v24.19.0.
**HOLD:** supported Bun/native checks and required human review remain outstanding for upstream promotion.
A specific single downstream publication lease permits this new branch only. No upstream post or promotion is authorized.

Kevin Rajan implemented the example in [PR #10829](https://github.com/can1357/oh-my-pi/pull/10829).
The literal-marker requirement and original diagnosis came from the
[automated Codex review](https://github.com/can1357/oh-my-pi/pull/10829#discussion_r3965253375).
Codex prepared this candidate; no original human diagnosis, independent user incident, human review or DCO is claimed.
The privacy documentation promises regex scrubbing and supports `PAW_PII_PLACEHOLDER`;
the explicit literal replacement contract comes from the review.

Base/owner: `a4dd7b79ed88313a11ad05b76ab206ca5435b247`, branch `feat/paw-pii-extension-example`.
New isolated candidate: `fix/pii-literal-placeholder-20261011`, created directly from that owner head.
It does not include or descend from the separate byte fix `6e29189aa29014904fb2734a5d1bd52a2c539cd0`.
Owner and byte-fix branches are untouched. Fresh owner/review checks confirmed the head and an unresolved,
non-outdated finding. Fork branch enumeration and placeholder issue/PR body/comment searches found no competing
claim or fix; generic search hits concerned unrelated background notices, WebFetch, harmony and prompt templates.

## Smallest behavior change

Only the three `String.replace` replacement arguments change from `placeholder` to `() => placeholder`.
Regexes, defaults, PAW subprocess behavior, traversal and binary handling are unchanged.
The required changelog entry describes this user-visible example behavior.

The regression invokes the real factory-registered `before_provider_request` handler with PAW unconfigured,
extension enabled, and a configured placeholder. Every case covers email, phone and SSN together:

```text
input: mail synthetic@example.com phone 555-123-4567 ssn 123-45-6789
expected: mail <literal marker> phone <literal marker> ssn <literal marker>
markers: $&amp; | $&amp;amp; | $& | $$ | $` | $' | [PII]
```

RED: **1 pass / 6 fail**, exit 1. Ordinary `[PII]` passes; all replacement-token cases fail.
For literal `$&amp;`, the original output retains each match and appends `amp;`;
for `$&`, the input is unchanged. `$$` collapses to `$`; prefix/suffix tokens interpolate context.
The literal `$&amp;amp;` is a separate additional ten-character fixture, not accidental HTML encoding of
the six-character `$&amp;` fixture. Its original output appends `amp;amp;` to each retained match.
All three dollar/ampersand markers are separate source strings, with no HTML decoding step.
GREEN: **7 pass / 0 fail**, exit 0, including ordinary `[PII]` behavior.

No guarantee is made for placeholders that themselves resemble PII: later regex passes can match earlier
inserted marker text. This does not sanitize opaque bytes, fix arbitrary object handling, or change PAW policy.
The handler string path is exercised; ExtensionRunner, native graph, detector processes and live providers are not.

## Reproduce from repository root

The loader maps `bun:test` to `node:test` and resolves extensionless relative `.ts` imports.
Node's native experimental TypeScript transformation evaluates the actual complete source modules;
there are no extracted functions, rewritten implementations or module mocks. Type-only imports are erased,
so the heavy coding-agent/ModelRegistry/pi-natives graph is bypassed. Environment changes are restored in `finally`.

```sh
# GREEN: 7 pass / 0 fail
node --experimental-transform-types --import ./evidence/pii-literal-placeholder/node-source-loader.mjs \
  --test packages/coding-agent/test/pii-redact-literal-placeholder.test.ts

# RED: 1 pass / 6 fail; baseline is the exact original complete source
baseline_dir=$(mktemp -d)
baseline_source="$baseline_dir/pii-redact.ts"
trap 'rm -f "$baseline_source"; rmdir "$baseline_dir"' EXIT
git show a4dd7b79ed88313a11ad05b76ab206ca5435b247:packages/coding-agent/examples/extensions/pii-redact.ts > "$baseline_source"
OMP_PII_BASELINE_SOURCE="$baseline_source" node --experimental-transform-types \
  --import ./evidence/pii-literal-placeholder/node-source-loader.mjs \
  --test packages/coding-agent/test/pii-redact-literal-placeholder.test.ts
```

Focused formatter/linter commands, using source-lock-matched official npm tools installed only in temporary
storage with `--ignore-scripts --no-audit --no-fund`: oxfmt **0.65.0**, oxlint **1.81.0**; npm **11.9.0**.
No generated dependencies are part of the candidate.

```sh
oxfmt --check packages/coding-agent/examples/extensions/pii-redact.ts \
  packages/coding-agent/test/pii-redact-literal-placeholder.test.ts evidence/pii-literal-placeholder/node-source-loader.mjs
oxlint packages/coding-agent/examples/extensions/pii-redact.ts \
  packages/coding-agent/test/pii-redact-literal-placeholder.test.ts
node --check evidence/pii-literal-placeholder/node-source-loader.mjs
git diff --check
sha256sum -c evidence/pii-literal-placeholder/SHA256SUMS
```

Formatting: all three matched files correct. Lint for the two TS files: exit 0, no diagnostics.
The mjs loader is excluded by lint selection; formatter and Node syntax checks cover it. Diff whitespace: pass.
Bun was unavailable in the existing toolchain check (exit 127); no source-matched OMP native addon was found.
Workspace-supported Bun is **1.4.0**, runtime floor **1.3.14**. No prior Bun download or canceled probes were retried.
These results are not full Bun-suite acceptance or `bun check`. Current contribution rules permit focused
downstream preparation, while upstream submission requires human inspection, a human-written explanation and
relevant verification. No upstream promotion is asserted.

## Independent review and identities

A separate explicitly requested xhigh critic independently ran the exact registered-handler regression:
RED 1 pass / 5 fail, GREEN 6 pass / 0 fail under Node24.19. It verified baseline blob/base head,
review state, per-test environment restoration, narrow callback-only behavior and packet limits.
No functional or scope blocker was found. Its namespace node:path import convention finding in the
evidence loader was corrected; formatter and syntax checks passed after that correction.
The publisher added the explicitly requested separate `$&amp;amp;` fixture and reran the final seven cases:
RED 1 pass / 6 fail and GREEN 7 pass / 0 fail. The independent six-case rerun above is kept distinct from
that additional evidence. Final publication review inspects the seven-case test and portable packet.
Disposition: LIMITED / HOLD. No human review or supported Bun/native acceptance was claimed.
Original extension Git blob: `49c349f3e64a1ea3a7d890dfb4fba1a2fba2ebbd`.
SHA256SUMS pins the fixed source, regression, changelog, loader and this packet, excluding itself to avoid a cycle.

Pre-publication gates: owner head unchanged, owner and byte-fix branches untouched, new branch absent,
no intervening fork branch changes or competing claim, current automated review unresolved/non-outdated.
Sanitizer checks all new files and changed changelog content for host paths and credential patterns.
No dependencies, credentials or private state are included.
