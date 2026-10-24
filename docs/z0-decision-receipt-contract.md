# OMP → z0 decision/receipt correlation (synthetic example)

**Status:** documentation-only M3 slice of [mobile roadmap #158](https://github.com/kvnloo/oh-my-pi/issues/158), sourced from [OMP #109](https://github.com/kvnloo/oh-my-pi/issues/109). This is a proposed *join* over native OMP evidence, **not** a shipped adapter, wire schema, action dispatcher, scheduler, verifier or runtime test.

The proposed semantic contract belongs to [z0intelligence #53 (DecisionOpportunity/state)](https://github.com/kvnloo/z0intelligence/issues/53), [#54 (outcome/credit)](https://github.com/kvnloo/z0intelligence/issues/54) and [#62 (cross-harness integration)](https://github.com/kvnloo/z0intelligence/issues/62). OMP remains the execution harness. AODL/deterministic policy owns authority, an independent verifier owns outcome truth, and Tokenomics owns cost semantics. None of these roles can be inferred from an OMP trace alone.

## Native seams at a pinned source revision

The following symbols and behaviors are present on [fork main at 0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0](https://github.com/kvnloo/oh-my-pi/commit/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0):

| Native observation / entry point | What a thin *external* adapter can reference | What it does **not** establish |
| --- | --- | --- |
| [AgentTelemetryConfig.conversationId](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L340-L418); fallback to loop session ID | The existing GenAI conversation ID | z0 work-item or opportunity identity |
| [onSpanStart/onSpanEnd and TelemetryHookContext.span](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L315-L331); [startSpan](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L484-L526) | OTel spanContext trace ID and span ID; operation and conversation attributes | z0 trace IDs, unique retries, verifier identity |
| [chat step number](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L315-L326) | Ordering context for a chat span | Globally unique attempt ID; a retry can be a distinct span |
| [startExecuteToolSpan](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L1928-L1956) | gen_ai.tool.call.id, tool name, tool span | Permission to execute or independently verified success |
| [onChatUsage](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L252-L277) | Usage for chat steps *that actually report it*; no second counter | Absent usage = zero usage; authoritative pricing |
| [onRunEnd](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L399-L418) | Run summary and coverage, distinct from outcome | Verifier success, safe action, production completion |
| [resolveAttributes](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/agent/src/telemetry.ts#L357-L371) | An opt-in host can stamp known, non-sensitive external correlation references | Permission or schema/version negotiation |
| [OTLP export bootstrap](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/telemetry-export.ts) | Reuse existing opt-in export; do not add a second tracer | A live, connected collector or accepted remote export |

OTel trace IDs are derived from the **span context**, not from the conversation ID. A z0 trace reference is a **separate** join key; it must never overwrite OTel trace identity. The adapter must attach any z0 opportunity/attempt IDs from existing external state; OMP does not mint these IDs automatically.

## Entirely synthetic reference record

This JSON is intentionally **illustrative**, not a new canonical schema or a claim that OMP emits this object. Only the nested native fields correspond to current OMP span/callback surfaces; the external join fields belong to the proposed z0 adapter. IDs, tool action, usage, policy and execution in this sample are fictional.

~~~json
{
  "fixture": "synthetic-omp-z0-join-v1",
  "observed_omp_shape": {
    "otel_trace_id": "0123456789abcdef0123456789abcdef",
    "gen_ai.conversation.id": "fixture-session-01",
    "invoke_span_id": "0102030405060708",
    "chat": {
      "span_id": "1111111111111111",
      "gen_ai.operation.name": "chat",
      "omp.gen_ai.agent.step.number": 0,
      "reported_usage": {
        "gen_ai.usage.input_tokens": 18,
        "gen_ai.usage.output_tokens": 4
      }
    },
    "tool": {
      "span_id": "2222222222222222",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.call.id": "fixture-call-01",
      "gen_ai.tool.name": "read"
    },
    "run_end_callback": "summary_and_coverage_observed"
  },
  "proposed_external_join": {
    "z0_trace_ref": "fixture-z0-trace-01",
    "work_item_ref": "fixture-work-01",
    "opportunity_ref": "fixture-opportunity-01",
    "intent_revision": "fixture-intent-r1",
    "state_revision_ref": "fixture-state-r2",
    "evidence_refs": [
      "fixture-evidence-01"
    ],
    "legal_candidate_actions": [
      "read_fixture"
    ],
    "proposed_action": "read_fixture",
    "authority": {
      "source": "synthetic_deterministic_AODL_policy_gate",
      "policy_revision": "fixture-policy-r1",
      "decision": "allow_for_fixture_only"
    },
    "attempt": {
      "attempt_ref": "fixture-attempt-01",
      "otel_trace_id": "0123456789abcdef0123456789abcdef",
      "otel_span_id": "2222222222222222",
      "tool_call_id": "fixture-call-01",
      "execution_result": "completed_in_fixture"
    },
    "outcome": {
      "outcome_ref": null,
      "verifier_ref": null,
      "verification_status": "unverified",
      "verified_result": null
    },
    "measurement": {
      "input_tokens": 18,
      "output_tokens": 4,
      "usage_coverage": "reported_for_one_chat_span",
      "cost_usd": null,
      "cost_coverage": "unknown"
    }
  }
}
~~~

The join associates a tool span and existing call ID with an **externally assigned** attempt reference. The separate z0 trace, work-item, state revision and opportunity IDs are correlation metadata, not native OMP fields. Here a *fictional* deterministic AODL gate permits the fixture read; model suggestions/JEV confidence did not grant it. The tool is marked completed **only in this synthetic fixture**; the independent verifier is absent, so outcome remains **unverified**.

## Minimal adapter contract to validate later

1. Capture OTel trace/span IDs at the current hooks. Join an externally supplied stable opportunity, work-item, revision and attempt reference **without altering OMP execution** or reinterpreting OTel IDs.
2. Carry legal action constraints from an authoritative AODL/policy check **separately** from proposed action and model score. Missing/denied authority must never be upgraded by telemetry.
3. Record actual tool execution independently of the later outcome. Missing verifier means unknown/unverified, even when the tool and run finish normally.
4. On retry, interruption, replay or duplicate export, retain the same opportunity/work-item lineage; add a distinct attempt only when an actual new execution is evidenced. Deduplicate by stable attempt/span/call identity. An uncertain timeout must not be replayed as a confirmed new effect.
5. Missing usage, cost, outcome or state evidence remains explicitly **unknown**. Reported zero is not the same as missing. Reject unsupported versions and stale state rather than silently dropping constraints or inventing verified success.
6. Observe with message-content capture disabled; do not export raw prompts, tool bodies, secrets or identifying host paths. Use existing opt-in [telemetry export](https://github.com/kvnloo/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/telemetry-export.ts), and a kill switch that leaves native OMP unchanged.

**Not covered by this document:** real OMP fixture round-trip, standalone z0 schema validation, multi-attempt persistence, offline/online transport, native overhead, provider calls, signed approvals, or verifier integration. These remain acceptance work for [OMP #109](https://github.com/kvnloo/oh-my-pi/issues/109) and [z0intelligence #62](https://github.com/kvnloo/z0intelligence/issues/62).

## Verification for OMP (not run by this connector-only edit)

- Inspect the pinned symbol links and ensure the JSON parses without relying on a live provider. All fields under proposed_external_join are **external illustrative semantics**, not claims about OMP public APIs.
- From the OMP repository root run: **bun check**.
- Run the native correlation/export regressions: **bun test packages/coding-agent/test/telemetry-export.test.ts**.
- For a future actual adapter, freeze a real OTel fixture from the exact installed revision, test replay/deduplication and missing-verifier paths, then supply an independent verifier. Only then can #109's full implementation acceptance be evaluated.

No runtime, GitHub Actions or physical-device check has been executed by this documentation change. Preserve original authors' and reviewers' credit through the linked OMP/z0 sources.
