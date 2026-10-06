# OMP UI × Omnara backend experiment

This experiment keeps OMP's **real InteractiveMode**—Composer, transcript,
tool cards, interaction surfaces, native TSP, and Tern rendering—and swaps only
the runtime boundary underneath it.

## Chosen surface

```text
OMP InteractiveMode / TSP / Tern
              ↓
AgentSession.prompt + injectExternalEvent
              ↓
Omnara REST + resumable SSE
              ↓
Omnara durable agent runtime
```

This deliberately uses Omnara's public agent API rather than
`internal/daemonprotocol`. The daemon protocol controls machines and
processes; the public API is the durable conversation and human-interaction
contract.

### Omnara calls used

- `POST /inputs` — user input.
- `GET /events` — recent durable timeline hydration.
- `GET /events/stream?stream_deltas=true` — resumable live stream.
- `GET /tool-calls?include_subagents=true` — authoritative tool state,
  including subagents.
- `GET /interactions?state=open&include_subagents=true` — human prompts.
- `POST /interactions/{id}/resolve` — answers.
- `POST /cancel` — stop the current agent.
- `GET /agents/{id}` — model/activity metadata.

## Why this is the minimal seam

OMP already knows how to render assistant streaming, generic tool execution,
interrupts, native dialogs, transcript history, and Tern surfaces. Recreating
those in a parallel UI would throw away the exact behavior this experiment is
trying to reuse.

The Hermes experiment established the narrow host seam:

1. override `AgentSession.prompt` for remote submission;
2. translate backend events to `AgentSessionEvent`;
3. feed them through `AgentSession.injectExternalEvent`;
4. keep `InteractiveMode` unchanged.

Omnara reuses that same seam. Only the backend adapter differs.

## State rules

Omnara durable events are authoritative.

- `agent_input`, `model_output`, `tool_result`, and
  `context_checkpoint` are durable timeline truth.
- `model_output_delta` is presentation-only streaming preview.
- `tool_call_update` is a notification; the adapter refreshes
  `/tool-calls` for authoritative state.
- reconnect resumes from the latest durable sequence via the SSE cursor.
- locally submitted inputs use Omnara idempotency keys so their durable echo
  does not duplicate OMP's optimistic user row.

Omnara `tool_use` and `max_tokens` outputs do **not** end the OMP run.
Terminal stop reasons (`end_turn`, `refusal`, `content_filter`, `error`)
emit OMP's terminal `agent_end`.

## Native human-in-the-loop UI

Omnara interactions are queried through the public interaction API and shown
using OMP's existing native selector/input surfaces. Resolution is sent back to
the interaction's owning agent, including subagent-owned prompts.

The first slice supports ordinary single-select questions, free-text questions,
and optional text attached to a selected option. Multi-select remains open in
Omnara rather than silently choosing for the user.

## Run

```bash
OMNARA_TOKEN=omnara_pat_v1_... \
OMNARA_ORG_ID=org_... \
OMNARA_PROJECT_ID=proj_... \
OMNARA_AGENT_ID=agt_... \
bun run omnara:tui
```

For self-hosted Omnara, also set `OMNARA_API` to the deployment's `/api/v1`
origin.

## Deferred

- image/media submission
- full subagent transcript browsing
- multi-select interaction UI
- custom-tool result submission
- model/agent selection inside OMP
- richer provider usage/reasoning metadata

## Provenance

- OMP's InteractiveMode, TUI, native surface stack, and TSP/Tern implementation:
  Can Bölük / Stencil Labs.
- Omnara's public agent, event, tool-call, and interaction contracts: the Omnara
  team.
- Backend-inversion experiment—keep OMP presentation intact and swap only the
  runtime boundary: Kevin Rajan.

This is an isolated dogfood experiment, not an upstream architecture
recommendation.
