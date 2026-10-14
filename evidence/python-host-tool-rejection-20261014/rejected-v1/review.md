# Independent review: OMP155 host-tool registration rollback

Verdict: changes requested. The target explicit-rejection behavior is fixed in the frozen candidate, but two independent probes expose regressions.

## Reviewed inputs

- Baseline ref: `f5145fd0271906cdf3bca6a218912fa1d8db3500`
- Candidate `src/omp_rpc/client.py` SHA-256: `296024ebeb63ecd5a472836b6876c9b3a22784ddff0da0e91c293bdb7917a44d`
- Frozen `tests/test_host_tool_registration.py` SHA-256: `d8b0668952d76d7e01b0a5b71d5d04a9d655f85494c23609c423d3313eb7d67f`
- Python: 3.12.14
- All 18 baseline files reproduce the Git blob hashes and sizes in the supplied source manifest. Only `src/omp_rpc/client.py` differs among those candidate originals. The new regression test file is identical in both arms. This is an independent local manifest verification; the source-fetch provenance was provided by the implementation owner.

## 1. High priority: an interrupted request can roll back a newer successful registration

Location: `client.py:2074-2083`, together with `client.py:1481-1492`.

`_request_data` removes its pending entry for write failures and `queue.Empty`, but not when waiting raises `KeyboardInterrupt`. The new outer registration lock is released as that exception propagates. A newer registration can then succeed while the earlier pending request still contains rollback metadata. A later explicitly identified rejection of that earlier request unconditionally assigns its stale `host_tools_before` to `_custom_tools`.

The independent subprocess test sends a real SIGINT to the test process while the first registration is pending. After catching the interruption, it registers `new`. The peer sends the earlier rejection before acknowledging the new request:

- Baseline: new setter returns `('new',)`; local handlers are `['new']`; the callback returns `new accepted`.
- Candidate: new setter returns `('new',)`; local handlers have reverted to `['accepted']`; the callback returns `Host tool "new" is not registered`.

The stale pending entry is pre-existing, but successful-registration state corruption is introduced by this patch. Rollback needs a registration-identity/generation guard or cleanup that also handles interrupted waits. A reused tuple object must not defeat identity tracking.

Reproducer: `reproduce_interrupted_registration.py`; paired logs: `baseline-interrupted.log`, `candidate-interrupted.log`.

## 2. Medium priority: holding the registration lock through the reply creates a callback dependency cycle

Location: `client.py:1026-1056`.

A host handler invoked before the outer registration acknowledgement can itself call `set_custom_tools`. The new setter lock remains held by the outer waiting caller, so the handler blocks trying to register. If the peer awaits the handler's result before sending the outer acknowledgement, neither side progresses until the outer request times out.

Using the implementation's existing real-pipe `early` callback mode:

- Baseline: both nested and outer registration succeed, with outer elapsed time about 0.001 seconds.
- Candidate: outer registration raises `RpcTimeoutError` after the configured 0.25 seconds; only then can nested registration complete. The default timeout is 30 seconds.

This is a reproduced SDK behavior change under the same early-callback fixture already used by the patch. Native Bun server reachability of this exact dependency was not established. The docs do not explicitly promise reentrant registration, so this finding should not be presented as a proven native-server deadlock. Either avoid waiting under a lock needed by callback work, or explicitly settle and test the supported reentrancy contract.

Reproducer: `reproduce_reentrant_registration.py`; paired logs: `baseline-reentrant.log`, `candidate-reentrant.log`.

## Independent commands and results

From each arm:

`PYTHONPATH=src python3 -B -m unittest -v tests.test_host_tool_registration`

- Baseline: 11 run; 6 pass, 4 failures, 1 error.
- Candidate: 11 run; all pass.

From candidate:

`PYTHONPATH=src python3 -B -m unittest -v tests.test_client tests.test_host_uris tests.test_protocol`

- 104 tests run; all pass (4.658 seconds). Log: `candidate-adjacent.log`.

From each arm:

`PYTHONPATH=src:. python3 -B ../evidence/reviewer/reproduce_interrupted_registration.py`

`PYTHONPATH=src:. python3 -B ../evidence/reviewer/reproduce_reentrant_registration.py`

- Both baseline repros exit 0.
- Both candidate repros exit 1 at the behavior assertion described above.

## Contract and scope

Independently read frozen source:

- [RPC replacement contract](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/docs/rpc.md#L735-L780)
- [Server setter order](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L2136-L2140)
- [Session duplicate validation and registry restoration](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/session/session-tools.ts#L2254-L2305)

The bridge is mutated before session validation, so rejection is not a full server-side atomic transaction. The fixture validates Python SDK handler dispatch and rollback over actual subprocess pipes. Native Bun-server integration, complete repository checks, and pytest-only tests were not independently run. No production code was changed, and nothing was published.
