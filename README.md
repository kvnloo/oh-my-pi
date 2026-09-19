# @z0/omp-ext-agy-executor

AGY as a **first-class OMP executor** (research + implementation) with a **front-door** that bypasses Cursor/Auto.

## Why

If Cursor thinks first then delegates, we already paid the rate-limit cost.
This extension consumes `agy:…` / `/agy …` on the OMP `input` event with `{ handled: true }` so the root provider turn never starts.

## UX

```text
/agy research <prompt>
/agy implement <prompt>
agy:r <prompt>
agy:i <prompt>
```

## P0.6 everyday manual lane

- `AgyDriver` applies per-turn permission profiles and **always restores** (`finally` + process `exit` best-effort).
- Never uses `--dangerously-skip-permissions`.
- Warm path: `print + --conversation` (no stream-json residency).
- Agents:
  - `z0-researcher` — read-only tools allowlist
  - `z0-implementer` — explicit edit/test tools in frontmatter (`tools:`) so `-p` has parity with default agent
- Tokenomics lanes remain: `omp.agy.route` / `omp.agy.research` / `omp.agy.implementation`

Sync agents into AGY global config:

```bash
cp -a agents/z0-*/agent.md ~/.gemini/config/agents/z0-*/
```

## Modes

- `manual` (default): only explicit routes
- `shadow-auto`: Jev/heuristic predicts lane, **no authority**
- `auto`: not enabled

```bash
export OMP_AGY_EXECUTOR_MODE=manual
export AGY_BIN=agy   # or path to mock-agy for tests
```

## Load

```bash
ln -s /home/kvn/tmp/omp-ext-agy-executor/index.ts \
  ~/.omp/agent/extensions/agy-executor.ts
```

## Test

```bash
bun test
bun run eval:e2e
AGY_BIN=/home/kvn/.local/bin/agy bun run eval:p05
```
