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

The launch command starts the real OMP screen. `PI_HERMES_BACKEND=1` replaces only `session.prompt`.

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

## Branch map

`exp/hermes-backend` is the base. It has the proven real-screen path: one submit, one `prompt.submit`, one assistant reply. Do not add the next feature on this branch.

`exp/hermes-backend-preview` starts at the tool-card tip. It now contains the slices that passed alone: lsp, grep, glob, write, web-search, todo, execute-code, browser, ask, cron, approval, clarify, secret, interrupt, subagent, read, edit, bash error, tool duration, two tool ids, and the LSP mux socket.

Merge a later feature branch here only after that branch passes alone. Do not merge a feature branch into the base.

The cheap check is `.github/workflows/hermes-backend-slices.yml`. It runs the bridge map test. It does not replace a live pane check.

## Proven on the real screen

- one Hermes session at startup
- the real OMP submit call goes to Hermes `prompt.submit`
- one assistant reply appears in the real OMP transcript

Not proven on the real screen yet:

- tool cards
- subagent rows
- Escape to `session.interrupt`
- approval, clarify, and secret prompts
- resumed sessions
- the model picker

The gateway client declines approval, clarify, and secret requests. That decline is not a live pane proof.

## Provenance

- OMP's TUI, native surface stack, and Tern/TSP implementation are the work of
  Can Bölük / Stencil Labs and remain unchanged by this experiment.
- The Hermes ↔ Tern work in `kvnloo/hermes-agent#431` and RFC `#432` established
  the protocol constraints and the clean Hermes-first integration path.
- Kevin Rajan proposed this inverted experiment: preserve OMP's complete frontend
  and adapt Hermes at the backend boundary instead of rebuilding OMP presentation
  inside Hermes.

This branch is an experiment, not an upstream architecture recommendation.
