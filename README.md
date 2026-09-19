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

## Modes

- `manual` (default): only explicit routes
- `shadow-auto`: Jev/heuristic predicts lane, no authority
- `auto`: not enabled in P0

```bash
export OMP_AGY_EXECUTOR_MODE=shadow-auto
export AGY_BIN=agy   # or path to mock-agy for tests
```

## Load

```bash
ln -s /home/kvn/tmp/omp-ext-agy-executor/src/extension.ts \
  ~/.omp/agent/extensions/agy-executor.ts
```

## Test

```bash
bun test
bun run eval:e2e
```
