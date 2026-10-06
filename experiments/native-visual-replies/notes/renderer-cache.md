# Renderer interaction-cache slice

Parent: `experiment/native-visual-replies` at `f008c5a7`. Independent of lifecycle and capture slices. Only the experimental renderer and its synthetic fixture change at runtime.

Keep a block-local LRU of at most eight immutable directory/mode projections. Warm Code/Churn toggles and Back reuse projected arrays rather than sorting the same directory again. Preserve selection by node id across mode changes and restore the parent selection on Back. Ignore modified character shortcuts; repeated selection of the same leaf keeps the cached view.

The 128-cell Other disclosure and aggregate totals are unchanged. Caches are not persisted or shared across blocks. This bounds cache entries, not an advertised process-memory budget.

```sh
node --test experiments/native-visual-replies/core.test.mjs
node experiments/native-visual-replies/renderer-test.mjs
```

The renderer test defaults to a `luau` executable. For a Lua 5.4 executable, set `NATIVE_VISUAL_LUA=/path/to/lua`. The source uses their shared syntax subset; the runner concatenates the EXACT host source with a stub Tern boundary and tests. It does not transpile production source or install an interpreter.

Measured here: 15 renderer logic checks pass using system Lua 5.4, plus 16 Node contracts. The 50k-file test makes two sorts to initialize the two modes and zero additional sorts over 40 warm toggles. This is a work-count invariant, NOT a Luau, frame-rate or input-to-paint benchmark. Eight checks fail on a baseline with only equivalent conditional-expression syntax lowering; that baseline is not a real Tern run.

The fixture was regenerated against the new renderer hash. Old approvals correctly require a new preview after this source change. Actual Luau JIT, luau-lsp, native CSS/layout, focus and Tern rendering remain unverified.

Credit Kevin for performance/isolation requirements; Brit for the explainer direction; OMP/Tern maintainers for the block, event and cached-view contracts; bmdavis419/T3 contributors for the original lifecycle. References: RFC #143, PR #144 and https://docs.stencil.so/tern/guides/blocks.html.
