# Independent review: OMP155 revised registration rollback

Verdict: no blocking finding remains in the reviewed Python SDK scope. V2 resolves both independently reproduced V1 regressions. This is approval of the local repair and its focused Python verification, not a claim of native-server or whole-repository qualification.

## Frozen inputs

- Baseline upstream ref: `f5145fd0271906cdf3bca6a218912fa1d8db3500`
- Candidate `src/omp_rpc/client.py` SHA-256: `611122886c8bc85381709a85c95bbbe15d8158b62e85fe8192b4b2f29080f68a`
- `tests/test_host_tool_registration.py` SHA-256: `04e792dbede6a343a5c063370c498957ec0039c47a5b17593605ad871bf5facb`
- Python: 3.12.14

## Findings resolved

1. A real SIGINT during an unacknowledged registration previously allowed that request's late rejection to restore stale handlers over a newer successful registration. V2 settles the interrupted registration as uncertain; the later outcome cannot mutate its record. The original independent reproducer now passes, and the committed tests also cover reuse of the exact same tool tuple.
2. The V1 registration lock spanned the response wait, creating a dependency cycle when a pre-ACK host handler registered another tool. V2 publishes under the existing write lock, releases it before waiting, and tracks outcomes separately. The original independent nested-registration reproducer now completes successfully in about 0.001 seconds.
3. Publication is ordered with actual writes, including reversed caller scheduling. Rejected predecessor records are skipped, while accepted or uncertain records become fallback anchors. There is no new state-lock-to-write-lock inversion in the reviewed client call sites.

## Independently executed verification

From each arm:

`PYTHONPATH=src python3 -B -m unittest -v tests.test_host_tool_registration`

- Baseline: 15 test methods; 7 failure records and 1 error. Failure counts include subtests.
- Candidate: 15 test methods; all pass (0.926 seconds).
- Logs: `baseline-v2-registration.log`, `candidate-v2-registration.log`.

From candidate:

`PYTHONPATH=src python3 -B -m unittest -v tests.test_client tests.test_host_uris tests.test_protocol`

- 104 tests; all pass (4.633 seconds).
- Log: `candidate-v2-adjacent.log`.

`PYTHONPATH=src:. python3 -B ../evidence/reviewer/reproduce_interrupted_registration.py`

`PYTHONPATH=src:. python3 -B ../evidence/reviewer/reproduce_reentrant_registration.py`

- Both exit 0. These are the unchanged independent reproducers that failed V1.
- Logs: `candidate-v2-interrupted.log`, `candidate-v2-reentrant.log`.

`PYTHONPATH=src:. python3 -B ../evidence/reviewer/review_outcome_model.py`

- All 405 possible three-registration ordered-send/outcome traces pass the independent latest-unrejected-registration model, including success, rejection, uncertainty, and arbitrary response order.
- A direct response-boundary check confirms that only literal `success=False` rolls back. `0`, empty string, `None`, and an absent success field retain proposed handlers.
- This is an additional helper/response-state check, not a subprocess or native-server integration test.
- Log: `candidate-v2-outcome-model.log`.

## Additional independent full-SDK and targeted static checks

From candidate:

`PYTHONPATH=src <existing-test-python> -B -m pytest -q tests`

- 122 tests passed, 38 subtests passed in 6.03 seconds.
- Log: `candidate-v2-pytest.log`.
- Uses the existing environment supplied by the implementation owner; no new installation was performed by the reviewer.

`<existing-test-python> -m ruff check tests/test_host_tool_registration.py`

`<existing-test-python> -m ruff format --check tests/test_host_tool_registration.py`

- Both pass for the new test file. Source and test hashes were rechecked unchanged afterward.
- Full SDK lint is not green. The implementation owner reports the same 42 normalized pre-existing diagnostics and the same six original formatting failures in both arms; that full lint comparison was not independently rerun.

## Limits and remaining pre-existing behavior

- The late explicit-ID fallback miscorrelation tracked separately as origin #12555 remains intentionally unchanged. The test establishes that this patch does not additionally roll back the newer registration because of that unrelated identified response.
- The pre-existing pending-request entry left after KeyboardInterrupt still exists. V2 prevents new rollback state corruption without broadening this repair into general request cleanup.
- Real subprocess pipes are exercised by the registration suite and both independent reproducers. The peer is Python. No native Bun server was run.
- Server bridge mutation precedes session validation. This repair does not make registration a full atomic server-side transaction.
- Full repository builds, generated-source checks, and native-server integration are outside the independently executed commands above.
- No production edits, publication, pushes, or remote mutations were performed by this reviewer. All reviewer artifacts are under `evidence/reviewer/`.

## Contract references

- [RPC tool replacement contract](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/docs/rpc.md#L735-L780)
- [Server setter order](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L2136-L2140)
- [Session duplicate validation and registry restoration](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/session/session-tools.ts#L2254-L2305)
