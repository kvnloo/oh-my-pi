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
thin NDJSON bridge client
              ↓
Omnara CLI bridge (official SDK + resumable SSE)
              ↓
Omnara durable agent runtime
```

The key boundary is deliberately split by ownership:

- **OMP owns presentation.** Omnara events are translated into normal
  `AgentSessionEvent` lifecycle events, so existing OMP transcript/tool/dialog
  rendering and TSP/Tern behavior stay intact.
- **Omnara owns transport and API semantics.** The companion
  `omnara agents bridge-omp` process uses Omnara's official TypeScript SDK for
  authentication, generated request/response contracts and resilient event
  streaming.
- No Omnara React/Ink renderer is embedded in OMP, and OMP no longer
  reimplements Omnara's HTTP paths or SSE reconnect loop.

This is narrower than wiring OMP directly to Omnara REST/SSE and avoids a
second implementation of Omnara's stream recovery rules.

## Bridge protocol

The Omnara companion branch exposes a renderer-neutral newline-delimited
JSON-RPC process.

OMP requests:

- `agent.get`
- `events.list`
- `tool_calls.list` (including subagents)
- `interactions.list` (open interactions including subagents)
- `input.create` with an OMP-generated idempotency key and
  `queued | steering` delivery mode
- `interaction.resolve`
- `agent.cancel`
- `stream.start` / `stream.stop`

Omnara notifications:

- `ready`
- `stream.event`
- `stream.connection`
- `stream.error`

The public Omnara API remains the authoritative backend contract; the bridge is
only a process boundary around the official SDK.

## OMP host seam

The OMP side stays intentionally small:

1. override `AgentSession.prompt` for remote submission;
2. translate Omnara event frames to `AgentSessionEvent`;
3. feed them through `AgentSession.injectExternalEvent`;
4. map OMP abort to Omnara cancel;
5. use OMP's existing native selector/input surfaces for Omnara interactions;
6. keep `InteractiveMode` unchanged.

This is consistent with the UI-as-client direction demonstrated by André
Braït's OMP session-host work, while keeping this experiment isolated from that
PR.

## State rules

Omnara durable events are authoritative.

- `agent_input`, `model_output`, `tool_result`, and
  `context_checkpoint` are durable timeline truth.
- `model_output_delta` is presentation-only streaming preview.
- `tool_call_update` is a notification; the adapter refreshes authoritative
  tool state through the bridge.
- reconnect/cursor recovery is owned by Omnara's official
  `openAgentEventStream`.
- locally submitted inputs carry OMP-generated Omnara idempotency keys so their
  durable echo does not duplicate OMP's optimistic user row.

Omnara `tool_use` and `max_tokens` outputs do **not** end the OMP run.
Terminal stop reasons (`end_turn`, `refusal`, `content_filter`, `error`)
emit OMP's terminal `agent_end`.

## Native human-in-the-loop UI

Omnara interactions are queried through the bridge and shown using OMP's
existing native selector/input surfaces. Resolution is sent back to the
interaction's owning agent, including subagent-owned prompts.

The first slice supports ordinary single-select questions, free-text questions,
and optional text attached to a selected option. Multi-select remains open
rather than silently choosing for the user.

## Run

For source-to-source dogfooding, point OMP at the companion Omnara checkout:

```bash
OMNARA_ROOT=/path/to/kvnloo/omnara \
OMNARA_API_KEY=omnara_pat_v1_... \
OMNARA_ORG_ID=org_... \
OMNARA_PROJECT_ID=proj_... \
OMNARA_AGENT_ID=agt_... \
bun run omnara:tui
```

If the companion `omnara` CLI is installed, `OMNARA_ROOT` is unnecessary.

The adapter also maps the earlier experiment aliases `OMNARA_TOKEN` →
`OMNARA_API_KEY` and `OMNARA_API` → `OMNARA_API_URL`.

## Deferred

- image/media submission
- full subagent transcript browsing
- multi-select interaction UI
- custom-tool result submission
- model/agent selection inside OMP
- richer provider usage/reasoning metadata

## Provenance

- OMP's InteractiveMode, TUI, native surface stack, and TSP/Tern
  implementation: Can Bölük / Stencil Labs.
- OMP's UI-as-client/session-host direction: André Braït.
- Omnara's chat/event projection work: Christian Sparks, Asher Dale, and
  ksarangmath, building on the Omnara team's public agent contracts.
- Backend-inversion experiment—keep OMP presentation intact and swap only the
  runtime boundary: Kevin Rajan.

This is an isolated dogfood experiment, not an upstream architecture
recommendation.
