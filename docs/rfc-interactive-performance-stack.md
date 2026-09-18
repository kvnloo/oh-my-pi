# RFC: OMP interactive performance stack

Fork-only integration for `kvnloo/oh-my-pi`. See branch `rfc/interactive-performance-stack`.

## Deliverables

- Handsfree + Stage Manager + Live voice
- Jev + `computer.decide()`
- RLM v1/v2 (depth-0 + depth-1)
- Tokenomics bridge (root + worker events)
- Dev monitors under `scripts/dev/`

## Deferred

- `cu.perception_route.v0` benchmark harness

## Tests

```bash
python3 -m unittest discover -s python/omp-hud/tests -v
bun test packages/coding-agent/test/rlm-context-engine.test.ts
bun test packages/coding-agent/test/rlm-tokenomics-bridge.test.ts
```
