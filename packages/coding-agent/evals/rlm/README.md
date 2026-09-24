# RLM offline A/B eval

Data-driven scorecard for the prompt-as-variable spill engine (`src/rlm/`).

## Arms

| arm | meaning |
|-----|---------|
| `off` | Full tool bodies stay in root context |
| `on`  | RLM spill: oversized tool text → `rlm://h/<id>` stubs + store |
| `shake` | Head/tail truncate to `spillBytes` — midpoint needles lost, no store |

## Metrics

| id | definition |
|----|------------|
| M1 | `1 - rootCorpusBytes/originalBytes` on RLM arm |
| M2 | context-token drop RLM vs full (`Tokenizer.countTokens`) |
| C3 | no planted needle inside spilled stubs |
| M5 | needle recoverable (`RlmStore.search` on; shake: present in truncated body) |

## Run

```bash
cd packages/coding-agent
bun evals/rlm/orchestrate.ts
bun evals/rlm/report.ts          # exit 1 on gate failure
bun test test/rlm-context-engine.test.ts test/rlm-v1-acceptance.test.ts
```

## Gates (`workloads.json`)

- M1 ≥ 90% body reduction on fat workloads (RLM)
- M2 ≥ 30% context token drop vs full (W1/W2/W3)
- C3 needle never in stub
- M5 search recovers needle when on
- shake arm present; RLM not 2× worse tokens than shake; RLM keeps M5 when shake drops midpoint

## Live vLLM (GPU)

When a tools-capable OpenAI-compatible server is up (default `http://127.0.0.1:8000`):

```bash
VLLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct bun evals/rlm/live-vllm-harness.ts
# writes results/live-vllm.jsonl (gitignored)
```

Measures: spill stub + root payload drop, `RlmStore.search` needle (M5), live `rlmQuery` TTFT/tokens via streaming chat completions (`cost=$0` local).

Agent multi-turn RPC (`live-slm-bench.ts`) is optional; small SLMs often fail bash/eval schemas — the harness is the load-bearing live gate.

## RFC v2 (depth-1)

Offline: `bun test test/rlm-v2-subcall.test.ts`

- `rlm op=subcall` with `task` + `handle`/`handles` when `rlm.maxDepth≥1` (ephemeral worker A2 — no third runtime, no depth≥2).
- `rlm.kernelBind` (default false): read-only bind helpers in `src/rlm/kernel-bind.ts` for EvalRunner injection.

### Depth-1 offline

```bash
bun evals/rlm/depth1-orchestrate.ts
bun evals/rlm/depth1-report.ts
```

### Depth-1 live vLLM

```bash
VLLM_MODEL=Qwen/Qwen2.5-1.5B-Instruct bun evals/rlm/live-vllm-depth1.ts
```


## Clean evidence-selection A/B

Branch experiment: `exp/rlm-evidence-ab-clean`.

This experiment is eval-only. It does **not** change the RLM runtime and it does
**not** claim to be a native OMP end-to-end benchmark.

It isolates one question: when the evidence worker has an ~8 KiB budget, is a
fixed first slice sufficient, or is evidence addressing load-bearing?

Arms:

| arm | evidence |
|-----|----------|
| `full` | full-context proxy; upper bound, not native OMP |
| `fixed8k` | first `QUERY_SLICE` bytes/chars |
| `search8k` | literal ranges selected from workload-specified query patterns, capped to `QUERY_SLICE` |

The `search8k` arm is conditional on a usable lexical query supplied by the
workload. It tests **addressing after query formation**, not whether the agent
can generate a good search query.

Run deterministic mechanism gates:

```bash
cd packages/coding-agent
bun evals/rlm/evidence-ab-orchestrate.ts
bun evals/rlm/evidence-ab-report.ts
```

Run an OpenAI-compatible live model:

```bash
RLM_BENCH_LIVE=1 \
RLM_BENCH_RUNS=5 \
RLM_BENCH_BASE_URL=http://127.0.0.1:8000 \
RLM_BENCH_MODEL=Qwen/Qwen2.5-1.5B-Instruct \
bun evals/rlm/evidence-ab-orchestrate.ts

bun evals/rlm/evidence-ab-report.ts
```

For a remote OpenAI-compatible endpoint, set `RLM_BENCH_API_KEY`.

Decision rule:

1. mechanism gate must show at least one fixed-position miss recovered by
   `search8k` under the same evidence cap;
2. live runs are descriptive until repeated across models/tasks;
3. if `search8k` survives, the next experiment is **query generation**, not
   more RLM membrane/runtime architecture;
4. only after query generation works do we run an end-to-end native OMP vs RLM
   agent benchmark measuring root + worker tokens, latency, retries, cost, and
   task success.


## Query-generation gate

After the clean evidence-selection A/B passes, the next uncertainty is whether a
cheap helper can form useful literal searches without seeing the hidden corpus.

`querygen-orchestrate.ts` gives every non-oracle arm only:

- the user task;
- the tool-result source name;
- the existing RLM stub preview (240 chars from the head + 240 from the tail).

The hidden corpus, expected answer tokens, and oracle patterns are never passed
to the generator.

Arms:

| arm | purpose |
|-----|---------|
| `oracle` | authored search patterns; retrieval upper bound only |
| `lexical` | deterministic task + stub baseline; essentially zero model cost |
| `model` | live cheap-model query generator with the same visible inputs |

The experiment stops at **retrieval sufficiency**. It does not call the evidence
answer worker, so a miss is attributable to query formation/search rather than
answer-generation quality.

Offline fixture/baseline check:

```bash
cd packages/coding-agent
bun evals/rlm/querygen-orchestrate.ts
bun evals/rlm/querygen-report.ts
```

Live cheap-model run:

```bash
RLM_QUERYGEN_LIVE=1 \
RLM_QUERYGEN_RUNS=5 \
RLM_QUERYGEN_BASE_URL=http://127.0.0.1:8000 \
RLM_QUERYGEN_MODEL=Qwen/Qwen2.5-1.5B-Instruct \
bun evals/rlm/querygen-orchestrate.ts

bun evals/rlm/querygen-report.ts
```

Any OpenAI-compatible endpoint can be used. Set `RLM_QUERYGEN_API_KEY` when
needed. Servers that reject `response_format` are retried without it.

The provisional promotion bar is deliberately simple:

1. oracle retrieval must remain 100%, otherwise the fixture/search policy is
   invalid;
2. the model should retain at least 80% of oracle retrieval success;
3. the model must not trail the deterministic lexical baseline;
4. query-generation tokens are included in the reported system-token proxy;
5. even a pass only promotes us to a real-trace / end-to-end experiment — it
   does **not** justify more RLM runtime architecture.
