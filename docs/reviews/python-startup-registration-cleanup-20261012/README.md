# Python startup registration cleanup

Owner=ayo. Canonical claim: [kvnloo/oh-my-pi#152](https://github.com/kvnloo/oh-my-pi/issues/152), created/read back by parent before coding. Branch: `ayo/fix-python-startup-registration-cleanup-20261012`. Exact base/current upstream main: `5d0aaffaf1f987503ce129a642fb6e30339615af`. This branch starts from upstream, independently of #151.

## Requirement, observed failure and repair

The server [rejects duplicate host tool names](https://github.com/can1357/oh-my-pi/blob/5d0aaffaf1f987503ce129a642fb6e30339615af/packages/coding-agent/src/session/session-tools.ts#L2419-L2428). The [TypeScript client](https://github.com/can1357/oh-my-pi/blob/5d0aaffaf1f987503ce129a642fb6e30339615af/packages/coding-agent/src/modes/rpc/rpc-client.ts#L507-L529) includes initial registration in startup cleanup specifically to avoid a retained worker/session lock before retry. Python uses context entry for start; failed entry does not invoke context exit.

On exact base, initial custom-tool registration is outside the protocol-negotiation cleanup guard. A real Python JSONL subprocess emits ready, receives duplicate registration, sends an unsuccessful response and keeps reading stdin. The actual `RpcClient` raises `RpcCommandError`, but its child and both reader threads remain alive. Both v1 and successfully negotiated v2 reproduce it. Correcting tools and retrying fails with `RPC client is already started`.

Minimal repair: extend the existing negotiation `try` through both initial registration calls; use the existing `stop()` and bare `raise`. Ready timeout/pre-ready exit behavior is retained. Runtime setters, response routing, stop/reaping algorithm and server code are unchanged. Original registration exception command and message are checked. The normal callback-before-registration-ack and retry paths remain functional.

## Native subprocess evidence

Python 3.12.14 (SDK supports >=3.11). Real disposable stdlib JSONL subprocess and actual Python client; no mocked stop or reimplemented client. Tests capture the child/readers on ready, assert lifecycle outcomes, and safely stop only their own spawned child in `finally`/test cleanup even on RED. No descendants or external providers are required.

From candidate `sdk/python/omp-rpc`:

```sh
PYTHONPATH=src python3 -B -m unittest -v tests.test_client.StartupRegistrationTests
```

GREEN: **4 PASS, 0 FAIL**. [Log](focused-green.log). Cases: rejection after ready (v1), rejection after negotiation (v2), retry after failed entry, and successful callback before registration acknowledgement. The first two assert child reaped and both captured reader threads stopped before returning the error. Retry creates a different live worker and shuts it down normally.

The exact final four tests are frozen in [regression.py](regression.py). From the untouched detached base SDK directory:

```sh
PYTHONPATH=src python3 -B /tmp/omp-startup-frozen.py -v
```

`/tmp/omp-startup-frozen.py` was copied from the frozen regression file unchanged. RED: **1 PASS, 2 FAIL, 1 ERROR** (4 total). Both rejection failures show `(False, False, False)` for `(child reaped, stdout stopped, stderr stopped)`; retry errors with already-started. Success control passes on base. [Log](focused-red.log). This is executed lifecycle evidence, distinct from TypeScript/server source reasoning.

## Full SDK and inherited limits

On base and candidate, respectively, from `sdk/python/omp-rpc`:

```sh
PYTHONPATH=src /tmp/omp-python-checks/bin/python -B -m pytest -q tests
```

- Exact base: **106 PASS / 1 FAIL**, 34 subtests PASS. [Log](sdk-base.log).
- Candidate: **110 PASS / 1 FAIL**, 34 subtests PASS. [Log](sdk-candidate.log).
- Identical inherited failure: `RetainsSurvivorTests.test_terminate_waits_for_killed_term_ignoring_grandchild`, teardown returned False where test expects True. No teardown algorithm, credential, security or unrelated cleanup change was made. Full SDK is not green.

Isolated tooling environment `/tmp/omp-python-checks`: pytest9.1.1, Ruff0.17.0; no dependency change in repository. Commands from repository root:

```sh
/tmp/omp-python-checks/bin/ruff check sdk/python/omp-rpc --output-format json
/tmp/omp-python-checks/bin/ruff format --check sdk/python/omp-rpc
/tmp/omp-python-checks/bin/ruff format --check /tmp/omp-startup-frozen.py
git diff --check
```

SDK lint: 43 diagnostics on both base and candidate, zero new (path/rule/message) fingerprints. SDK formatting: same 7 files needing formatting on both. Added test block alone was formatted; frozen regression format and whitespace check pass. [Summary](lint-summary.json). Existing formatting/lint was not repaired. Python robomp and monorepo/Bun verification are outside this SDK change; no Bun download was attempted.

## Ownership, critic and scope

Fresh fork claims and [PR77](https://github.com/kvnloo/oh-my-pi/pull/77) (`0a6fcc7b76816c885251a42df60127bc667e36ad`) were inspected before editing. PR77 touches the older Python path but not this startup initialization block. No overlapping startup registration claim was found. #151 is a separate handler rollback fix; its failed release write remains blocked and was not retried.

Related owners retained: marcelojmontanez [#12555](https://github.com/can1357/oh-my-pi/pull/12555) request routing; roboomp [#12842](https://github.com/can1357/oh-my-pi/pull/12842) output bounds and merged [#12843](https://github.com/can1357/oh-my-pi/pull/12843) reaping; andrebrait [#14166](https://github.com/can1357/oh-my-pi/pull/14166) / [#14468](https://github.com/can1357/oh-my-pi/pull/14468); anthonyrisinger [#15300](https://github.com/can1357/oh-my-pi/pull/15300); roboomp [#15169](https://github.com/can1357/oh-my-pi/pull/15169). Their fresh diffs do not fix the unguarded initial registration. Do not infer native execution of those PRs.

Original path authors: can1357 (client path latest `fd4542b21d`), Sunil Srivatsa (test path latest `96e7dcc76f`); existing notices preserved. roboomp's reaping work is reused, not reauthored.

Independent xhigh critic found no blocking findings: focused candidate 4/4 PASS; exact baseline 1 PASS / 2 FAIL / 1 ERROR; related checks 60 PASS / 1 FAIL with the same teardown failure reproduced on exact base. An independent host-URI-only startup rejection subprocess probe also verified original error preservation and child/reader cleanup. `git diff --check` PASS. The critic made no edits or GitHub writes. Native Python subprocess evidence is not full OMP/Bun integration, hosted CI, live provider acceptance or production session-lock proof.

QA: LIMITED / downstream candidate. Parent owns recording #152 result/releasing the claim. This agent makes no GitHub API writes, upstream post, main/force push, fake human signoff or credential recovery. Authorization and publication readiness remain separate.
