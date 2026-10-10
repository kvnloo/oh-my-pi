# Independent shimmer verification contract

Frozen 2026-10-10 16:59 UTC, before reading shimmer implementation or candidate diff.
Scope: ANSI styling generated within one plain-text shimmer input segment. No
claim is made that this repairs arbitrary authored ANSI, native truncation, or a
grapheme deliberately split across distinct palette/semantic input segments.

## Visible contract

1. Remove generated ANSI SGR sequences from output: the text must be unchanged.
2. Every generated SGR boundary within a single input segment must occur at a
   Unicode extended-grapheme boundary. Build the boundary oracle independently
   with a fresh `Intl.Segmenter(undefined, { granularity: "grapheme" })`; never
   import the production segmentation helper into the oracle.
3. A multi-code-point grapheme has a single shimmer tier, selected at its first
   code point. The next grapheme starts at the original cumulative code-point
   position. Animation period, phase, and ASCII output must remain unchanged.
4. Empty segments, entirely empty input, stable/nonanimated rendering, disabled
   shimmer, and the native/TSP rendering path retain prior observable behavior.
5. Preserve each input segment's palette ownership and palette/style fallback.
   Adjacent segments that split a grapheme are separately characterized, not a
   silently broadened promise of Unicode-safe author-defined style boundaries.

## Regression families

- ZWJ profession: `👩‍💻tail`
- Variation selector: `❤️tail`
- Combining accent: `étail`
- Regional-indicator pair: `🇺🇳tail`
- Family ZWJ chain: `👨‍👩‍👧‍👦tail`
- Skin-tone modifier: `👍🏽tail`
- Empty, ASCII, and mixed `a👩‍💻b❤️céd🇺🇳e👍🏽f` controls

## Real path

Call `createVibeToolRenderer("wait").renderResult` for a running screen, spinner
frame 0, current tool `read`, and the fixture tool args, then render at fixed
wide and narrow widths. Freeze `Date.now` at 467 ms with a per-test spy and
restore it in `finally` or `afterEach`, including failures. Derive expected
visible truncation prefixes from independent segmentation of the unstyled
renderer text and a width budget; do not call the truncation helper to compute
expected output. Assert both the cell-width bound and complete-grapheme prefix.
Tests must invoke renderer only, with fabricated result details. Do not execute
the tool, call a model, start a session, or contact a service.

## Evidence and gates

No runtime, build, installation, or connector actions until root grants a slot.
Run the exact same independent assertion program against the unchanged baseline
and candidate. Keep raw output and exact revisions. Expected RED is a generated
SGR boundary inside a grapheme and/or a real renderer's partial-cluster prefix;
GREEN must not rely on weakening those assertions. A width-only success does not
prove complete-grapheme rendering. Review fake-clock restoration and side effects.

## Frozen cost comparison

Use paired baseline/candidate runs, warmed, with multiple interleaved rounds.
Report medians and range, absolute time per operation, and throughput only as
secondary context. Do not claim synthetic helper gains as product gains.

- Helper ASCII: `Reading package.json and updating renderer output`, 48 visible
  ASCII code points, changing frame time in 40 ms steps.
- Helper Unicode: `Reading 👩‍💻 src/❤️/é/🇺🇳/👍🏽/👨‍👩‍👧‍👦.ts`, changing time.
- Real wait renderer ASCII tool args: `packages/coding-agent/src/theme/shimmer.ts`
- Real wait renderer Unicode tool args: `src/👩‍💻/❤️/é/🇺🇳/👍🏽/👨‍👩‍👧‍👦.ts`
- Each real renderer case at widths 40 and 100, frame time advancing by 40 ms,
  spinner frame advancing with iteration, fabricated running-screen details.
- Disabled shimmer and stable/nonanimated renderer serve as controls.

Use identical workloads, process settings, number of iterations, and native
binding on both sides. Freeze iteration count after a bounded calibration made
before inspecting timing deltas. Measure costs even when Unicode correctness
requires additional segmentation; reject unsupported speedup claims.
