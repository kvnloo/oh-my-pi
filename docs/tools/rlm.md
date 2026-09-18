# rlm

> Peek, search, query, or depth-1 subcall over spilled long context that is not in the neural window.

## Source

- Entry: `packages/coding-agent/src/tools/rlm.ts` (`RlmTool`)
- Store: `packages/coding-agent/src/rlm/`
- Registration: `packages/coding-agent/src/tools/index.ts`

## Registration / Visibility

- Requires `rlm.enabled = true` **or** `context.engine: rlm` (Settings → Context → RLM, or `/rlm on`).
- Defaults **off** (`context.engine: native`). Native compaction stays the default context engine.
- Metadata: `strict = true`, `loadMode = "essential"`, read approval.
- Mid-session `/rlm on` installs the tool via `setRlmToolEnabled` and sets `context.engine=rlm`.

## Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `context.engine` | `native` | `native` \| `rlm` exclusive engine selection |
| `rlm.enabled` | `false` | Session opt-in (also set by `/rlm on`) |
| `rlm.spillBytes` | `20480` | Spill threshold for tool-result text |
| `rlm.maxDepth` | `0` | `0` = peek/search/query only (v1). `1` = allow one nested `subcall` over granted handle slices (v2). Depth ≥ 2 is not implemented. |
| `rlm.maxCalls` | `32` | Hard cap on rlm query/subcall completions per session store |
| `rlm.maxTotalTokens` | `1000000` | Token charge cap |
| `rlm.maxCost` | `0` | USD-style cost cap (`0` = unlimited) |
| `rlm.wallClockMs` | `0` | Wall-clock budget from store creation (`0` = unlimited) |
| `rlm.subModel` | `""` | Optional sub-model id for query/subcall (empty = active model) |
| `rlm.kernelBind` | `false` | When true, expose read-only RLM handle helpers to the EvalRunner kernel (no full-body repr) |

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `peek` \| `search` \| `query` \| `subcall` \| `status` | Yes | Operation |
| `handle` | string | peek/search/query/subcall | `rlm://h/<id>` from a spilled stub (primary handle) |
| `handles` | string | subcall | Comma/space-separated handles for multi-hop grants |
| `start` / `end` | number | No | Slice offsets (primary handle for peek/query/subcall) |
| `pattern` | string | search | Needle (literal by default; `mode=regex` for RegExp) |
| `mode` | `literal` \| `regex` | No | Search mode; default `literal` |
| `question` | string | query | Question over a capped slice (depth-0) |
| `task` | string | subcall | Worker task over granted slices (depth-1; `question` accepted as alias) |
| `limit` | number | No | Search hit cap |

## Behavior

Tool results larger than `rlm.spillBytes` are replaced with a stub handle. Original bytes stay in the session `RlmStore` and never enter the next root provider request (`convertToLlm` fixture covered).

- **Runtime guide** is appended *after* the stable system prompt (prompt-cache safe for base bytes). Tool roster may still change when the `rlm` tool is installed mid-session.
- **`query`** is depth-0: completer sees only a capped excerpt via `ToolSession.rlmComplete` → isolated ephemeral turn (model registry + usage). Missing completer / cancel / `maxCalls` / `maxTotalTokens` / `maxCost` / `wallClockMs` **fail open**.
- **`subcall`** is depth-1 (RFC v2 / #12407): requires `rlm.maxDepth ≥ 1`, a `task`, and one or more granted `handle`/`handles` slices. Worker is a single nested ephemeral completion over granted excerpts only — no tool loop, no depth ≥ 2. `maxDepth=0` or `depth > maxDepth` **fail open**.
- **Cancel** leaves handles + trajectory intact (`store.cancel`).
- **Compaction** of root chat must not clear the store (maintenance does not call `resetRlmStoresForTest`).

See RFC [#12400](https://github.com/can1357/oh-my-pi/issues/12400) (spill engine) and [#12407](https://github.com/can1357/oh-my-pi/issues/12407) (depth-1 subcall). Offline scorecard: `packages/coding-agent/evals/rlm/`. Depth-1 unit gate: `bun test packages/coding-agent/test/rlm-v2-subcall.test.ts`.
