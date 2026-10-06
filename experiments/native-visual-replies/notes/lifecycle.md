# Preview lifecycle slice

Parent: `experiment/native-visual-replies` at `f008c5a7`. Independent of renderer-cache and capture slices; merge into the baseline separately. No core API, dependency, schema, renderer or installed-setting changes.

The extension now captures session identity before its first asynchronous read, checks cancellation/lifecycle before directory and file writes, preserves inspection on a retry of identical immutable data, and rechecks approval ownership after the final asynchronous file check. It does not open a stale confirmation after a branch/session reset.

Run from the repository root with Node 22.16+:

```sh
node --import ./experiments/native-visual-replies/tests/extension-loader.mjs --test experiments/native-visual-replies/core.test.mjs experiments/native-visual-replies/extension.test.mjs
```

The loader strips types and implements Bun's text import/import.meta.dir for the test. It instruments real filesystem awaits. The OMP registration, UI and lifecycle interfaces are stubbed: this is NOT OMP runtime or permission-system verification.

Against the original extension, 7 of the 22 new tests failed. After the 20-line production diff, all 22 new tests and 16 existing contracts pass. Cancellation during an in-flight write may leave a complete private snapshot on disk; it is not registered, approved or published. This slice does not add pruning or hostile-local-process isolation.

The manual approval remains exactly that: a human inspection claim, not automated pixel evidence. Real OMP/Tern dogfood is still required.

Credit Kevin for feature-isolation/minimal-change constraints; Brit for the explainer direction; bmdavis419/T3 contributors for preview-verify-publish; OMP/Tern maintainers for the reused extension lifecycle. See RFC #143 and PR #144 for the provenance chain.
