# Python host URI registration rejection

Owner: ayo. Canonical downstream claim: [kvnloo/oh-my-pi#151](https://github.com/kvnloo/oh-my-pi/issues/151). Branch: `ayo/fix-python-host-uri-rejection-20261012`. Base and freshly observed upstream main: `5d0aaffaf1f987503ce129a642fb6e30339615af` (2026-10-12). Downstream-only; no upstream issue, PR, comment, merge or signoff.

## Requirement and change

`docs/rpc.md` documents full replacement and scheme regex `[a-z][a-z0-9+.-]*`; `RpcHostUriBridge.setSchemes` validates the entire replacement before mutation. Register `db`, reject replacement with scheme `1bad`, then server still sends `db` reads. Baseline Python instead forgets that accepted handler and sends a not-registered error. Literal `scheme1bad` is valid; the initial claim's shorthand is corrected here.

Keep the proposed tuple available before sending registration, since callbacks can precede the acknowledgement. Store the previous tuple on this pending request and restore it in the reader on a correlated unsuccessful response, before releasing the waiter or dispatching later callbacks. Serialize only URI registration setters so one rejection cannot undo another setter. No generic transaction abstraction, changes to server behavior, new dependency or request-routing repair.

Timeout, transport failure, and malformed successful response remain uncertain; they do not prove server rejection and retain proposed handlers as before. The existing request-ID fallback can misreport an expired identified failure to a newer setter (#12555); the new rollback explicitly refuses to mutate the newer handler set in that case. That pre-existing routing error is not repaired here. An ID-less rejection that is unambiguously correlated still restores previous handlers.

## Native subprocess RED/GREEN

Python 3.12.14 (supported requirement >=3.11). Actual `RpcClient`, real local subprocess/stdin/stdout, existing stdlib `URI_SERVER` fixture extended with atomic validation and deterministic response/callback barriers. No replaced client implementation.

Commands run from the respective `sdk/python/omp-rpc` directory:

```sh
PYTHONPATH=src python3 -B -m unittest -v tests.test_host_uris
```

- Untouched original suite: 12 PASS.
- Initial explicit-rejection RED with four new controls: 15 PASS / 1 FAIL, 16 total. Failure is missing accepted db callback content after server rejection. [Log](focused-initial-red.log).
- Final fixed suite: 19 PASS / 0 FAIL. [Log](focused-green.log).
- Independent xhigh critic reran final suite: 19 PASS / 0 FAIL; `git diff --check` PASS. Found the stale-ID rollback hazard; the narrow rollback guard was added and independently verified. Final concurrency test checks observable callback behavior on either schedule.

Final frozen test file was copied to `/tmp/omp-final-test-host-uris.py` unchanged from this branch, then executed from the detached base's SDK directory:

```sh
PYTHONPATH=src python3 -B /tmp/omp-final-test-host-uris.py -v
```

Final base: 16 PASS / 3 FAIL, 19 total. Failures are identified rejection, ID-less rejection, and concurrent successful registration followed by rejection; each fails accepted callback content. [Log](focused-final-base.log). Reproduce by copying this branch's `tests/test_host_uris.py` to the same temporary path and importing base `src`.

Controls cover initial accepted registration, successful full replacement/removal, callback before acknowledgement, callback following rejection before setter resumes, accepted-without-ack timeout, stale identified failure not rolling back newer handlers, and concurrent setters. Callback barriers and thread events avoid timing sleeps for the new ordering checks.

## Full SDK verification and baseline limitations

The check environment is isolated in `/tmp/omp-python-checks`, with pytest 9.1.1 and Ruff 0.17.0; no project dependency change.

```sh
PYTHONPATH=src /tmp/omp-python-checks/bin/python -B -m pytest -q tests
```

- Exact untouched base: 106 PASS / 1 FAIL; 34 subtests PASS. [Log](sdk-base-pytest.log).
- Fixed SDK: 113 PASS / 1 FAIL; 34 subtests PASS. [Log](sdk-green-pytest.log).
- Same failure on both: `RetainsSurvivorTests.test_terminate_waits_for_killed_term_ignoring_grandchild`, expected process-group teardown result True but got False. No process/security changes or cleanup attempted. Full SDK is not green.

From repository root:

```sh
/tmp/omp-python-checks/bin/ruff check sdk/python/omp-rpc --output-format json
/tmp/omp-python-checks/bin/ruff format --check sdk/python/omp-rpc
/tmp/omp-python-checks/bin/ruff check sdk/python/omp-rpc/tests/test_host_uris.py
/tmp/omp-python-checks/bin/ruff format --check sdk/python/omp-rpc/tests/test_host_uris.py
git diff --check
```

Full SDK lint is not green: 43 base diagnostics, 42 fixed diagnostics, zero new diagnostic fingerprints (path/rule/message). Formatting reports the same 7 files needing formatting on both, including inherited client formatting. Changed test file lint and format pass; whitespace diff check passes. [Summary](lint-summary.json). Unrelated cleanup was not performed. Python robomp and full monorepo checks are outside this SDK change; Bun was neither required nor downloaded.

## Ownership and scope

Fresh related diffs, retained owners:

- [#15300](https://github.com/can1357/oh-my-pi/pull/15300), anthonyrisinger, `954c95cb153c62be5bff62c4303da11d4c02f0cc`: write response text, not Python registration rollback.
- [#14166](https://github.com/can1357/oh-my-pi/pull/14166), andrebrait, `c7c3523944a87a69120e35c433d6966b834b0e22`: server bridge cleanup, not this setter.
- [#12555](https://github.com/can1357/oh-my-pi/pull/12555), marcelojmontanez, `efdb5b2c2c2bb0cc2dacdacb034cf839990930f6`: request-ID routing. Preserve its ownership; legacy routing limitation remains separate.

Original Python client and host URI test code credit can1357 (latest path commits `fd4542b21d` and `c4d3204151`); this branch adds a bounded ayo repair and tests. Original licensing/attribution is preserved.

QA: LIMITED / downstream candidate. Native Python subprocess evidence is not full OMP/Bun integration, hosted CI, provider acceptance or certification of every SDK operation. The critic observed nested registration can stall with an artificial server that withholds the outer acknowledgement until a callback re-registers; actual OMP synchronous `setSchemes` creates no such dependency. Synthetic timing fixture coverage and source reasoning remain distinct from native server execution.
