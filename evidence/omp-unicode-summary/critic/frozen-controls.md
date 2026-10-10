# Independent grapheme-clipping acceptance controls

Frozen 2026-10-10 16:19 UTC before any candidate implementation was present or inspected. Baseline inspected: 1534f1a33954da73fc3c234cb0d146e6d6942f89. Public entry point is CollapsedSyntheticMessageComponent.render(width), not an extracted/reimplemented helper. Assertions use fixed semantic expectations and independently segmented grapheme prefixes; never use the proposed truncation helper as the oracle.

Scope: preserve complete Unicode grapheme clusters when clipping collapsed synthetic summary labels. Native renderer, body Markdown changes, and existing width-floor behavior are not claimed fixed.

Controls:
1. ZWJ woman-technologist clipping: heading `abcdef👩‍💻tail`, render width 11. Full visible prefix must be ` abcdef👩‍💻…`; no orphan ZWJ or individual emoji pieces.
2. ZWJ family boundary: heading placing `👨‍👩‍👧‍👦` at a clipping boundary. Entire family fits or is omitted. Sweep widths immediately below/at/above its complete cell width.
3. Skin-tone emoji modifier and regional-indicator flag: preserve full `👍🏽` and `🇺🇸` at boundaries. No unmodified base emoji / half flag when the full cluster cannot fit.
4. Combining mark and variation-selector/keycap clusters: `e\u0301`, `❤️`, `1️⃣`. No detached mark or dropped presentation selector due to clipping. Include clusters that consume final available column(s).
5. CJK: double-width glyph at exact fit and one-cell shortage; never exceed current effective summary width or render a partial glyph. This is a no-regression control.
6. ASCII: clipped and untruncated labels retain existing plain output, including ellipsis and statistics/hint. This is a no-regression control.
7. ANSI: SGR-colored heading behaves like its plain visible equivalent; escapes must remain complete. Check ANSI embedded immediately before and inside the clipped region. No requirement to preserve invisible byte-for-byte styling if the shared helper safely closes it.
8. Empty/no-heading synthetic content: keeps fallback label/stats; clipping must remain bounded and not crash.
9. Widths 0, 1, and 10 are explicitly negative controls for the pre-existing Math.max(10, width - 1) floor. Record existing overflow rather than silently changing it or attributing a fix.
10. Width changes + invalidate/releaseRenderCaches: repeat same-width render, resize down/up, and invalidate to ensure no stale/truncated cached output leaks across widths.
11. Expanded component: summary remains correct and body still appears after expansion; collapse again yields the same corrected summary. Run only if real dependency/native setup supports it.

Execution is blocked by root's resource lock until granted. No tests, builds, or installation performed while freezing these controls.

## Pre-candidate oracle correction, 2026-10-10 16:20 UTC

Control 1's initial seed from implementer understated the maximal prefix. Baseline source arithmetic: summary budget at render width 11 is 10 columns; Unicode ellipsis reserves 1, leaving 9. `abcdef` uses 6 and `👩‍💻` uses 2, so the first `t` also fits. Correct expected visible output is ` abcdef👩‍💻t…`, not ` abcdef👩‍💻…`. This correction is based only on baseline/helper semantics, before any candidate exists or is inspected. Component execution still pending root resource grant.
