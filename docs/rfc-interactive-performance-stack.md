# RFC: OMP interactive performance stack

Fork-only integration for `kvnloo/oh-my-pi`. See branch `rfc/interactive-performance-stack`.

## Deliverables

- Handsfree + Stage Manager + Live voice
- Jev + `computer.decide()` as a bounded, reversible semantic decision layer
- RLM v1/v2 (depth-0 + depth-1)
- Tokenomics bridge (root + worker events)
- Dev monitors under `scripts/dev/`

## JEV boundary

Dogfood JEV first on low-risk decisions where the existing path remains an immediate fallback. A JEV answer is a semantic suggestion/reference signal, not verified outcome truth, promotion evidence, or permission authority.

- errors, unsupported state, and low confidence fall through to the existing rules/rerank path;
- computer-use approval and capability policy remain authoritative for consequential actions;
- real dogfood traces should be joined later to Tokenomics/verifier outcomes and evaluated with complete work lineages kept together;
- promotion of a cheaper specialist is a separate, outcome-grounded evaluation step.

The goal of this branch is to learn whether the extra semantic decision can save more end-to-end latency than it adds, not to declare JEV correct by construction.

## Deferred

- `cu.perception_route.v0` benchmark harness
- formal grouped JEV/reference-vs-outcome evaluation until dogfood traces exist

## Tests

```bash
python3 -m unittest discover -s python/omp-hud/tests -v
bun test packages/coding-agent/test/rlm-context-engine.test.ts
bun test packages/coding-agent/test/rlm-tokenomics-bridge.test.ts
```
