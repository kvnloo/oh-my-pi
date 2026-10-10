# Freeze errata

- Source-only inspection located the target at `packages/tui/src/theme/shimmer.ts`
  and `packages/tui/src/tools/vibe.ts`, rather than `packages/coding-agent`.
- The frozen ASCII helper string has 49 code points, not the 48 annotated in the
  original note. The workload string itself is unchanged.
- The independent test harness takes no theme-global assignment and restores
  `Date.now`, native-rendering state, and the classic shimmer mode after each
  test. Rendering tests reject fetch, process spawn, and server startup calls.
- This file was written before any test or benchmark execution.

## Causal correction after baseline controls, before candidate inspection

The original real-path ZWJ and family expectations were invalid: vibe's existing
`frameText` calls `oneLineLabel`, whose sanitizer replaces Unicode Cf characters
(including ZWJ) with spaces before shimmer. An isolated stable/disabled renderer
test reproduced the same broken-looking ZWJ text without shimmer, exposing the
confounder. This is outside the shimmer change and is not being fixed here.

The original harness files are retained as `*.frozen-v1`; original logs are
retained as `baseline-*.v1.log`. The amended real-path oracle models the known
ZWJ-to-space preprocessing for these fixed inputs, then applies independent
grapheme segmentation and width budgeting to the displayed text. Direct helper
tests still require full ZWJ/family graphemes with no internal SGR boundaries.
The four unaffected real-path regression inputs are variation selector,
combining mark, regional-indicator flag, and skin-tone modifier.

The combined control group now omits animated Unicode, which is already the
regression group, so a failing animation cannot prevent all disabled/stable
controls from executing. No candidate source was inspected or executed before
this correction. The first baseline RED is evidence of the helper bug and the
four unaffected real-path bugs; its ZWJ/family real-path failures are not causal
evidence against shimmer.

The benchmark input strings remain frozen and unchanged. Its direct Unicode
helper workload retains ZWJ; its real wait-renderer workload passes through the
existing label sanitizer and thus measures spaces in place of ZWJ. Report those
as distinct workloads rather than claiming identical Unicode treatment.
