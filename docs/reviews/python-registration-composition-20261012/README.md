# Python registration composition qualification

Canonical [claim #153](https://github.com/kvnloo/oh-my-pi/issues/153), owner=ayo. Branch `evidence/python-registration-composition-20261012`. **Tested code/tests commit: `a18e610c6b2e03f49726ba630a06147bdb71fc26`**, base `3a9b01d06c118d56e035dda4e99caa272d6f646c`. Later receipt commits change evidence only.

## Exact composition and ownership

Cherry-picked with `-x`, retaining author/name/date and original commit references: #151 `7c560ff37f292455def20c931a753f629158e758` + `65cbf8ed6d71d318fb317236de404e35182a0cf4`; #152 `5d3c6869a23b6fe6d3aa8ec6f9dbb173973d189b` + `6126e9fc9deae12b2bbad8539cedc8ba063944d2`. No new production design or component-branch change. Combined client blob `78132603421be9f218e4dc1b6674ee247c4e2d94` is unchanged after the four picks. [Provenance/variant SHAs/test hashes](provenance.json).

New base has nine commits changing six TUI/keybinding/doc paths; client blob remains `93375fc12a2e8cb981363535addea9fd6d3baafc`. Before composing, read #153, factory #14/#65 and fork ownership; refreshed canonical [factory PR77](https://github.com/kvnloo/oss-factory/pull/77) and reused its previously read final inventory at unchanged head `8850cbbfc5a6fb41f48ce6de4b786f599b5ce7be`. Subsequent inventory readback confirmed its OMP runner-cache/existing-carrier continuations do not overlap. Final pre-push refresh is required separately. #151's HTTP401 release hold remains untouched; parent owns #153 result/release.

Original client/test authors can1357 and Sunil Srivatsa, roboomp's teardown work and neighboring PR owners retain credit and notices. Component receipts remain historical evidence; this receipt alone qualifies their current-base composition.

## Native execution and discrimination

Python3.12.14. Actual client and real stdlib JSONL subprocesses. New four v1/v2 tests reuse `STARTUP_REGISTRATION_SERVER`: successful tool callbacks precede acknowledgement; atomic initial URI rejection then cleans child/readers/pending state; correction/retry and restarts succeed; a later runtime rejected replacement preserves accepted callbacks and persisted registration across another restart. Initial URI rejection alone does not discriminate #151 because previous/proposed tuples coincide.

The second v1/v2 pair proves accepted-without-ack **startup timeout cleans the worker**, while **runtime timeout retains the worker and accepted callbacks**. Explicit echoed-result events synchronize asynchronous callbacks. Own disposable test processes are stopped even on failing controls.

From combined `sdk/python/omp-rpc`:

```sh
PYTHONPATH=src python3 -B -m unittest -v tests.test_host_uris tests.test_client.StartupRegistrationTests tests.test_registration_composition
```

**27 PASS**: existing19 URI +4 startup +4 composition. [Log](focused-combined.log). Independent xhigh critic independently ran27/27 PASS and confirmed reader rollback precedes response delivery, registration lock releases before startup cleanup, and no new lock/error-ordering bug.

Identical frozen test package copied to `/tmp/omp-registration-composition-tests`; hashes match committed tests. From each exact control SDK directory:

```sh
PYTHONPATH=src:/tmp/omp-registration-composition-tests python3 -B -P -m unittest -v tests.test_host_uris tests.test_client.StartupRegistrationTests tests.test_registration_composition
```

`-P` excludes cwd; all four import routes verified: actual variant client, identical frozen tests, no extracted/reimplemented production. [Imports](imports.json).

| Production variant | PASS | FAIL | ERROR | New4 composition tests |
|---|---:|---:|---:|---|
| Exact base |17|9|1|4 fail: retained child/readers |
| #151 only / omit startup fix |20|6|1|4 fail: retained child/readers |
| #152 only / omit rollback fix |22|5|0|2 timeout pass;2 lifecycle fail: accepted new handler not registered |
| Exact union |27|0|0|4 pass |

[Base](control-base.log), [#151 only](control-only151.log), [#152 only](control-only152.log). Each only-fix client blob equals its original component blob. The xhigh critic independently verified all control logs, actual import routes, frozen hashes, component metadata and unchanged production union. These controls establish each fix's necessity; no new bug or extra production repair was introduced.

## Full SDK and limits

From respective SDK directory:

```sh
PYTHONPATH=src /tmp/omp-python-checks/bin/python -B -m pytest -q tests
```

Exact base **106 PASS /1 FAIL**; combined **121 PASS /1 FAIL**;34 subtests PASS each. Same inherited `RetainsSurvivorTests.test_terminate_waits_for_killed_term_ignoring_grandchild` failure (False where True expected). [Base](sdk-base.log), [combined](sdk-combined.log). Full SDK is not green; no teardown rewrite.

From repository root:

```sh
/tmp/omp-python-checks/bin/ruff check sdk/python/omp-rpc --output-format json
/tmp/omp-python-checks/bin/ruff format --check sdk/python/omp-rpc
/tmp/omp-python-checks/bin/ruff check sdk/python/omp-rpc/tests/test_registration_composition.py
/tmp/omp-python-checks/bin/ruff format --check sdk/python/omp-rpc/tests/test_registration_composition.py
git diff --check 3a9b01d06c118d56e035dda4e99caa272d6f646c HEAD -- sdk/python/omp-rpc
```

Ruff0.17.0:43 base diagnostics/42 combined, zero new; same7 files need formatting, added test is formatted. New test lint/format and SDK whitespace diff pass. Full inherited commit diff has8 whitespace warnings in original #151 pytest receipt logs, preserved unchanged. [Summary](lint-summary.json). No unrelated cleanup.

**LIMITED / composition qualification**: Python subprocess evidence, not full OMP/Bun/provider/hosted-CI or production session-lock certification. No API write, #151 release retry, credential action, Bun download, request-ID/teardown rewrite, archive investigation, main/force push, upstream action or human signoff.
