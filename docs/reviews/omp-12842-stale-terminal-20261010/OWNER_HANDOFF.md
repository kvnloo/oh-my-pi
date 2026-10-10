# OMP #12842 exact-head independent Python acceptance

Checked 2026-10-10 23:45–23:46 UTC against roboomp's [open PR #12842](https://github.com/can1357/oh-my-pi/pull/12842), base `2e5311bb6eb824fedca5e84f49c292ca6957acc3`, exact head `f483ffeb8f029474e37c5c826dd4a983b3de1e1e`. Executed in a clean detached checkout; no source edit or upstream action. Current-head behavior is verified; whether this defect was newly introduced relative to the base is unverified.

## Executed owner-scope gate

From `python/omp-rpc`, using existing Python 3.12.14, `PYTHONPATH=src PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v tests.test_client tests.test_protocol tests.test_host_uris`: **71 tests, OK**, 2.669 seconds in the independent rerun. Exact output in `critic-owner-suite.log`. The owner's named five new regression tests ran. An exploratory extra fourth module, `tests.test_user_group`, could not import `pytest` from this environment; that 72-test command was not the owner's declared stdlib gate and its failure is a test-prerequisite limit, not a PR test failure. No dependencies were installed.

## Reproduced logic defect

The new [`_BoundedHistory.append` oversized-item path](https://github.com/can1357/oh-my-pi/blob/f483ffeb8f029474e37c5c826dd4a983b3de1e1e/python/omp-rpc/src/omp_rpc/client.py#L436-L474) increments `offset` but leaves already retained items in place. `snapshot_from(start_index)` then treats an old item as if it arrived after the caller's start index. This is not exercised by the added oversized-frame test, which checks snapshot and current index but not `snapshot_from` or a waiter.

Executed against the real `RpcClient` and production `_BoundedHistory` with an opt-in 60-byte event budget:

1. Append an old, valid `{'type': 'agent_end', 'messages': []}`.
2. Record `start_index=1`, exactly as a new prompt/collector does.
3. Append a new 100-character event, exceeding the budget.
4. Observe `offset=1`, `current_index=2`, retained history still containing the old `agent_end`, and `snapshot_from(1)` returning that old event.
5. `_wait_for_agent_end(1, 0, timeout=.05)` returns `['agent_end']` immediately, although no terminal event arrived after `start_index`.

The independent frozen regression and public-caller probe below reproduce this behavior. The observable risk is a new prompt/collection returning the prior turn's terminal result rather than raising overflow or waiting for the new one when a caller configures a byte limit below a possible event-frame size. This is a demonstrated current-head defect at a supported, explicitly configured 60-byte budget. Default-budget impact is untested. Although chunk reassembly is capped at 64 MiB and the default history budget is 256 MiB, the direct unchunked-frame path does not enforce the same cap; those constants alone do not exclude default-budget impact. No default-budget failure is claimed, and baseline newness is unverified.

Suggested owner acceptance test: retain an old terminal, record a new start index, append an oversized event, then assert `snapshot_from(start_index)` cannot return the old terminal and the waiter does not complete it as a new turn. The index representation needs to preserve gaps without reindexing old retained items. No fix attempted here.

## Frozen deterministic regression and controls

`regression_frozen.py` runs against the same exact-head production classes using only the Python standard library. It fixes the 60-byte budget and second-turn boundary in source, tests three controls (small new event, ordinary front eviction, and oversized first frame), then tests the stale-terminal gap, a new small event following the gap, and the real waiter. `critic-regression.log` records **three controls passing and three targeted assertions failing** in 0.022 seconds. The script has not been changed after this first run. Portable replay: from the exact-head checkout's `python/omp-rpc` directory, run `PYTHONPATH=src python3 -B /path/to/regression_frozen.py`; it exits 1 with the same three targeted failures. Substitute the actual location of the evidence script. The exact-head checkout remained clean.


## Independent public-caller verification

`critic_caller_probe.py` runs the unchanged production client against a local Python stdio protocol fixture. Two public `prompt_and_wait` calls exercise real subprocess pipes, JSON decoding, notification parsing, event admission, index capture, waiting, and `PromptTurn` construction. The fixture emits a first-turn terminal, then a valid second-turn `agent_start` and oversized `message_start`, but never a second terminal.

At the 60-byte budget, the second call incorrectly returns `['agent_end', 'agent_start']` with offset 2 and current index 4. With the byte budget disabled, it times out as expected. Result: **1 control passes / 1 assertion fails**, exit 1; `critic-caller-probe.log`. Run from the exact-head checkout's `python/omp-rpc` directory: `PYTHONPATH=src python3 -B /path/to/critic_caller_probe.py`. The script also supports execution beside a `source` checkout. This is Python client/subprocess integration with a controlled peer, not the Bun OMP application or live-model end-to-end testing.

Original byte-retention implementation and PR belong to roboomp. This packet contributes only independent acceptance evidence; no competing production fix, upstream comment, or publication was made. Refresh the PR head and ownership before external handoff.
