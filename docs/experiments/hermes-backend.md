# OMP UI × Hermes backend experiment

This branch keeps OMP's frontend/rendering stack authoritative and replaces only the
agent execution boundary with Hermes' existing `tui_gateway` JSON-RPC backend.

## Goal

Prove the shortest path to the OMP + Tern experience with Hermes semantics:

```text
OMP Composer / Transcript / TSP / Tern
                ↓
        thin JSON-RPC bridge
                ↓
        Hermes tui_gateway
                ↓
        Hermes agent runtime
```

No OMP model/tool runtime is used by this command.

## Run

From this repository:

```bash
HERMES_ROOT=/path/to/hermes-agent \
HERMES_CWD=/path/to/project \
bun run hermes:tui
```

If `tui_gateway` is already importable by your Python interpreter, `HERMES_ROOT`
is optional.

Optional environment variables:

- `HERMES_PYTHON` — Python interpreter.
- `HERMES_PYTHON_SRC_ROOT` — explicit Hermes Python source root.
- `HERMES_MODEL` — create the Hermes session with a particular model.
- `HERMES_PROFILE` — Hermes profile.
- `HERMES_CWD` — working directory for the Hermes session.

## First-slice contract

Implemented:

- fresh Hermes session creation
- OMP composer → Hermes `prompt.submit`
- Hermes assistant streaming → OMP transcript
- stable tool rows from `tool.start` → `tool.complete`
- stable subagent rows across the `subagent.*` lifecycle
- Escape → Hermes `session.interrupt`
- OMP's existing TSP/Tern renderer remains untouched

Not implemented yet:

- native approval / clarify / secret UI
- resumed sessions
- full OMP tool-specific renderer mapping
- OMP model picker backed by Hermes model APIs
- reasoning UI parity

For safety, unsupported consequential server requests are declined rather than
answered implicitly. Approval is denied, clarification is cancelled, and
sensitive string prompts are skipped.

## Provenance

- OMP's TUI, native surface stack, and Tern/TSP implementation are the work of
  Can Bölük / Stencil Labs and remain unchanged by this experiment.
- The Hermes ↔ Tern work in `kvnloo/hermes-agent#431` and RFC `#432` established
  the protocol constraints and the clean Hermes-first integration path.
- Kevin Rajan proposed this inverted experiment: preserve OMP's complete frontend
  and adapt Hermes at the backend boundary instead of rebuilding OMP presentation
  inside Hermes.

This branch is an experiment, not an upstream architecture recommendation.
