# @z0/omp-ext-cognitive-state

RLM Phase II — Shadow (P0) + **Guarded Active Canary** (P1).

> The transcript is an audit log, not cognition.

## Modes

| Mode | Default | Provider context |
|------|---------|------------------|
| `off` | | unchanged (extension idle) |
| `shadow` | **yes** | native (virtual packet compiled only) |
| `canary` | opt-in | virtual via `context` return; native fallback once |

Canary requires **both** `mode=canary` and `canary_opt_in=true` (env or settings).

```bash
export OMP_COGNITIVE_STATE_MODE=canary
export OMP_COGNITIVE_STATE_CANARY_OPT_IN=1
```

## Guarantees

- Canonical session transcript **unchanged**
- Virtual context only on explicit canary + safe task class
- Typed native fallback (once) with shared turn/trace ids
- `measured_tokens_avoided` only on verified virtual-success
- No OMP core patch

## Test / eval

```bash
bun test
bun run eval:reconstruction
bun run eval:canary
```
