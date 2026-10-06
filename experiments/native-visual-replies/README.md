# Native visual replies — opt-in setup

Canonical RFC: [#143](https://github.com/kvnloo/oh-my-pi/issues/143). HTML control: [#136](https://github.com/kvnloo/oh-my-pi/pull/136).

**No OMP/Tern core changes, new dependencies, daemon, browser runtime, or automatic plugin installation.** Everything here is explicitly loaded. This is a setup slice, not a production renderer or an end-to-end verification claim.

## What is implemented

- `visual_preview`: validates a repository snapshot, derives totals and an identity bound to the reviewed renderer sources, saves a private session-scoped immutable file, and returns an OMP-native summary plus text fallback.
- A fixed Tern Luau block renders that file as a Code/Churn treemap with tooltips, keyboard selection, drill/back, bars and a disclosed `Other` group above 128 visible children. No model/HTTP/timer/process calls in its view or event paths. Current code/churn units are caller-defined; the included fixture is explicitly synthetic.
- `/visual-approve <id>` records **human inspection** after a confirmation dialog. `visual_publish` requires this exact session/data/renderer identity and rechecks the file. Publication references the same snapshot, never re-generates it. The normal tool result is the transcript record; no second persistence subsystem.
- A bounded local OpenDesign package reader, an adapted authoring guide, deterministic tests, a JavaScript-only microbenchmark, and a real-Tern smoke driver.

This is **native summary in the transcript + expanded Luau pane**, not a fully inline interactive treemap. Age/Tests modes, durable drill position, automatic opening, and automated pixel-verification receipts remain RFC tasks. Session switching/branching/reload intentionally requires a new preview and approval. The installed plugin's actual build/theme/viewport are not automatically attested by the manual gate.

## Run the isolated checks

From the repository root (Node 22+):

```sh
node --test experiments/native-visual-replies/core.test.mjs
node experiments/native-visual-replies/study.mjs
```

The first command tests pure contracts, prior loading, and static guardrails. The second measures **JavaScript normalization/hash/projection**, not Luau execution or input-to-paint. It records raw cold/warm distinctions honestly; do not turn these values into a claimed native rendering speedup. `receipts/setup.json` states what actually ran during setup.

## Dogfood on a machine with OMP and Tern

Review `tern/` first: Tern plugins are trusted host code. Linking explicitly enables it. Run this before opening the experiment, using a separate Tern config/daemon/control window for isolation as documented by Tern. Do not run `plugins fixtures` against your normal configuration.

```sh
tern plugin link "$PWD/experiments/native-visual-replies/tern"
tern plugin reload
omp --no-extensions -e "$PWD/experiments/native-visual-replies/extension.ts"
```

Explicit `-e` remains enabled under `--no-extensions`; that flag is not whole-process sandboxing. Do not accidentally load the separate HTML branch's auto-discovered extension at the same time. `tern plugin link` must run on the host that owns the pane; web/mobile rendering requires the plugin on that host.

Inside Tern's palette, **Native visual: open synthetic demo** opens the checked-in sample. For a generated artifact, use Tern Files → **Open with Native Visual Reply** on the exact `.visual.json` path returned by `visual_preview`. This manual opening is deliberate in the first slice; no unsupported `tern open` API is assumed.

Ask OMP:

> Use visual_preview to produce a small repository explorer. Use measured data or clearly label synthetic data, and include code/churn units. Reuse the fixed native renderer. Stop for me to inspect it; do not claim a visual pass or publish automatically.

After checking the live result, run `/visual-approve <full-id>`, then request `visual_publish` with that id. Without approval, publication fails. No external sharing occurs. No JavaScript, Luau, shell commands, CSS, file paths or network endpoints can be supplied as executable artifact fields.

To remove the plugin later:

```sh
tern plugin unlink native-visual
```

## Live verification still required

Generate definitions with `tern plugin types experiments/native-visual-replies/tern`, then run from that directory:

```sh
luau-lsp analyze --platform=standard --definitions=@tern=tern.d.luau host.luau window.luau
```

Against an explicitly configured real window (`tern --control /tmp/native-visual-ctl.sock ...`) with this plugin ready:

```sh
sh experiments/native-visual-replies/tern-smoke.sh /tmp/native-visual-ctl.sock
```

The smoke opens the demo, changes mode, drills/back, requests a tree and screenshot. Inspect the pixels and record the environment. It does not generate an automated approval receipt. Standalone `tern shot`/`serve` do not normally load user plugins; a mock surface or catalog entry is not proof that this code renders. Clipboard, narrow width, theme changes, reduced motion, focus behavior, plain-terminal fallback and remote restart need real-host testing before promotion.

## OpenDesign without an extra harness

```sh
node experiments/native-visual-replies/prior.mjs /path/to/open-design/design-systems/selected-package
```

This reads only `manifest.json`, `DESIGN.md` and `tokens.css` from one explicitly selected local package. Output is bounded and hash/provenance tagged. It does not download assets, copy fonts, compile arbitrary CSS, or invoke OpenDesign's daemon. Map relevant semantic tokens onto Tern's supported palette deliberately; this initial viewer uses Tern tokens directly.

The integration is a generation-prior adapter, **not** a claim that OD Next runs unchanged under OMP. OD Next's current ship-on-write orchestration forbids post-generation checks, so it is explicitly excluded. Keep our verification loop. `authoring.md` describes the adapted workflow. Benchmark whether the smaller prompt/template prior actually helps rather than asserting that it does.

## Critical path and next slices

1. Run the fixed demo on real Tern; fix any actual API/CSS/input gaps before extending the schema.
2. Exercise the extension's preview → human inspection → publish loop in OMP. Preserve version/session ownership and plain-terminal behavior.
3. Add host-owned automatic capture/input evidence to replace manual approval; bind it to exact data, renderer, theme and viewport. Keep the previous good artifact on failure.
4. Compare arms A/B/C in `study.json`. Only then evaluate optional Jev UI routing in shadow through existing z0intelligence APIs. UI routing is not covered by unrelated verifier eligibility. No inference or paid requests are launched by this setup.
5. Only if expanded panes are insufficient, prove and patch the minimal inline `el`/stylesheet/event seam. Do not invent a new rendering protocol or general-purpose UI DSL.

## Safety and known limitations

OMP's private snapshot store and immutable identities are experiment hygiene, not a hostile-local-process sandbox. Tern `fs.read` has no pre-read size limit; the Luau reader checks the size after the read and should receive bounded OMP-owned snapshots, not adversarial local files. Schema checks reject executable extra fields and invalid identities/values. The Luau viewer projects known data fields only. A plugin VM's resource budgets do not make generated Luau safe.

Large datasets are a stress target, not yet a measured Luau guarantee. Directory sorting occurs when changing the active directory/mode, while view trees are cached; this first implementation has not proven the input-to-paint targets. Zero values receive minimum display area, disclosed in the UI. Reload restores path/mode but resets drill state. Full async cancellation/lifecycle stress and installed-runtime identity attestation remain required before production.

## Source and credit

- Brit identified the existing explainer workflow and suggested an ompish presentation direction in the user-supplied discussion; no endorsement is implied.
- bmdavis419 and T3 Code contributors: [preview/publish design](https://github.com/pingdotgg/t3code/pull/15968).
- OMP/Tern maintainers: [native component contract](https://github.com/can1357/oh-my-pi/blob/3f000c524cf82279f804ffd7526280cc9a5f25fe/packages/tui/src/native/node.ts), [blocks](https://docs.stencil.so/tern/guides/blocks.html), [element vocabulary](https://docs.stencil.so/tern/elements/el.html), [debugging](https://docs.stencil.so/tern/guides/debugging.html), [plugin security](https://docs.stencil.so/tern/concepts/security.html).
- nexu-io/OpenDesign contributors: [design packages](https://github.com/nexu-io/open-design/blob/53231d40b778d88eba23f35547bf99485d3ae9fc/design-systems/README.md), [orchestration profile, selectively adapted](https://github.com/nexu-io/open-design/blob/53231d40b778d88eba23f35547bf99485d3ae9fc/plugins/_official/scenarios/od-next-strategy/assets/general-orchestration.md). No source assets or fonts are vendored; preserve package-specific attribution on future imports.
