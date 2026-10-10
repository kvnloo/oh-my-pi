# Independent critic verdict: OMP #12842

**PASS for bounded, current-head, owner-safe evidence.** This is not approval of the whole PR or a claim that a production fix is green.

Owner: roboomp. PR: https://github.com/can1357/oh-my-pi/pull/12842

Executed head: `f483ffeb8f029474e37c5c826dd4a983b3de1e1e`. Python 3.12.14. The checkout was clean before and after verification. No production source change.

## Independent executions

From that checkout's `python/omp-rpc` directory:

1. `PYTHONPATH=src python3 -B -m unittest -v tests.test_client tests.test_protocol tests.test_host_uris`: exit 0, **71 passed**, 2.669 seconds. Receipt: `critic-owner-suite.log`.
2. `PYTHONPATH=src python3 -B /path/to/regression_frozen.py`: exit 1, **3 passed / 3 assertion failures**, 0.022 seconds. Receipt: `critic-regression.log`.
3. `PYTHONPATH=src python3 -B /path/to/critic_caller_probe.py`: exit 1, **1 passed / 1 assertion failure**, 0.101 seconds. Receipt: `critic-caller-probe.log`.

Replace `/path/to` with the location of the accompanying scripts. The executed runs used the equivalent `PYTHONDONTWRITEBYTECODE=1` setting. No dependency installation is needed.

## Why the finding is real

The oversized-append path increases `offset` without removing old retained items. `current_index = offset + len(items)` therefore advances but the index assigned to the old terminal advances too. The waiter rejects `start_index < offset`, but equality passes. At that point `snapshot_from(start_index)` can include an old `agent_end` and return it as part of the new collection.

The frozen probe directly verifies this boundary, a post-gap small frame, and the real waiter. Its controls distinguish ordinary front eviction, a small next frame, and a dropped first frame. The first oversized payload in that probe is admitted directly to the history rather than via notification parsing, so it alone is not evidence of wire ingress.

The separate critic probe closes that gap with valid parsed events and real subprocess pipes. A first public prompt returns `agent_start, agent_end`. For the second prompt, the fixture sends `agent_start, message_start`, then acknowledges the prompt; it never sends a second `agent_end`. The production client still returns `agent_end, agent_start`. The byte-limit-disabled control waits and times out. No real client method is mocked in this probe.

The public sequence is deterministic: the fixture sends events before acknowledging the corresponding command, so the client has consumed the oversized event before its waiter runs. The first terminal is 34 compact JSON bytes, and the next `agent_start` is 22 bytes; they fit together under the 60-byte budget. Ordinary front eviction removes the old `agent_start`, then dropping the oversized frame relabels the retained old terminal as index 2, exactly equal to the second prompt's captured boundary.

## Limits and owner-safe handoff

Demonstrated configuration: `max_event_bytes=60`. Default-budget impact is untested. The 64 MiB chunk-reassembly cap is not an equivalent check for unchunked frames, so it cannot establish a blanket exclusion for the 256 MiB default. Baseline newness is unverified; describe this as a current-head defect. This probe is client/protocol-fixture integration, not a Bun application or live model run.

Credit the existing roboomp PR and ask its owner to retain the turn-boundary invariant when dropping an oversized frame. Do not submit a competing production implementation. The `snapshot_from` expectations are evidence for this owner design, not a demand that every possible fix preserve an internal representation. Refresh current head and ownership before any external handoff.

## Identity hashes

- `regression_frozen.py` SHA256: `3fe19376afda82ea4010139de6c29b6862b72362b2d4b4ff04a7ce66b4e4f245`
- `critic_caller_probe.py` SHA256: `7ffc9f3dfa6c02e8c54b0ef16cd665f1ac329e6f4e1361c063f280ecf53c3421`
- Exact owner `python/omp-rpc/src/omp_rpc/client.py` SHA256: `82028497dc4d3f07545d898f2c68c34d212787df5ee3af39d1895befe130d8fb`
