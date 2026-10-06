# Repeatable Tern control evidence

Parent: `experiment/native-visual-replies` at `f008c5a7`. Independent of lifecycle and renderer-cache slices. No plugin installation, new daemon, general UI DSL or inference is added.

The existing smoke entry now delegates to a bounded Node runner:

```sh
sh experiments/native-visual-replies/tern-smoke.sh /absolute/test-control.sock
# Optional explicit output directory; it must not already exist:
sh experiments/native-visual-replies/tern-smoke.sh /absolute/test-control.sock /tmp/my-new-native-evidence
node --test experiments/native-visual-replies/core.test.mjs experiments/native-visual-replies/capture.test.mjs
```

Use a dedicated REAL Tern control window with the reviewed plugin loaded. Control input changes focus/mode in that window and opens the synthetic demo. Do not point at an unrelated working window. One operator must own the control during the run.

The runner checks the local fixture/renderer identity, checks the displayed preview prefix, exercises Code/Churn and drill/back, requests three screenshots, and records tree, CSS, state, command arguments, bounded stdout/stderr and control round-trip timings. It stops on the first failure. Each control call has a 15-second deadline and 1 MiB output budget. Logs are private, outside the watched plugin directory, and never overwrite an earlier run. Sources are checked again at completion.

`control-checks-passed` is NOT a pixel pass. The manifest always keeps publicationAuthorized, pixelsVerified, installedRendererAttested and paintLatencyMeasured false. Screenshot command responses are saved verbatim; PNG locations are not guessed or copied. Attach and inspect the actual Tern screenshots and record the host/runtime, theme, viewport and logs before asserting visual correctness. Control round-trip time is not input-to-paint time.

Ten runner tests with synthetic control responses and 16 existing contracts pass. A real CLI attempt here records `spawnSync tern ENOENT` and exits nonzero; it does not report a render pass. Real Tern control/API behavior remains unverified.

Credit Kevin for isolated, evidence-first work; OMP/Tern maintainers for the documented developer controls; Brit for the explainer direction; bmdavis419/T3 contributors for the lifecycle. Control syntax source: https://docs.stencil.so/tern/guides/debugging.html. Coordination: RFC #143 / PR #144. OpenDesign priors and default-off Jev remain unchanged.
