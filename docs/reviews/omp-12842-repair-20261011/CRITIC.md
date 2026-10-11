# Independent critic receipt: OMP #12842 repair

**PASS for the bounded stale-terminal repair validation.** This is local acceptance evidence for the demonstrated 60-byte configuration, not whole-PR approval or publication clearance.

Exact executed owner head: `7fa2a00b511b6ce6bbc83feb5cb2a5f501020968`. Its direct parent is `f483ffeb8f029474e37c5c826dd4a983b3de1e1e`. Python: 3.12.14. Read the owner root `AGENTS.md` first; no applicable nested omp-rpc instructions were found. The owner checkout remained clean, and all three changed files match the committed head byte for byte. Only the authorized parent-to-head repair diff was inspected. The prohibited base-to-old-head client diff was neither requested nor reconstructed.

## Packet integrity and actual import provenance

The frozen packet outside the owner worktree is `docs/reviews/omp-12842-stale-terminal-20261010`, from kvnloo/oh-my-pi commit `8458c8bc826f4c033335ab63a38205baa9c5dd38`.

- `sha256sum -c SHA256SUMS`, run from the packet directory: all eight entries OK.
- Independently compared all nine packet files, including `SHA256SUMS`, with their blobs at the specified commit: all byte-identical.
- `SHA256SUMS` SHA256: `19861fc98cc9100580ed098e8da0b1f3ae362e850bd2c5f271f3dc60823ea85a`.
- No packet `source`, `source/python/omp-rpc/src`, or `omp_rpc` exists, including symlink checks.
- Executed both actual unchanged scripts with `runpy.run_path(..., run_name="__main__")`, from `owner/python/omp-rpc` using `PYTHONPATH=src python3 -B`; propagated their exit codes and asserted every loaded `omp_rpc` module resolves under the owner checkout's `python/omp-rpc/src`.
- The actual caller script inserted its absent `source/python/omp-rpc/src` path. It still imported the owner package, client, protocol, host tools, and host URIs. This check verifies script execution provenance, not merely a separate import command.

Owner client SHA256: `fbe81bed89ca85af9928ac5f081dea0f27c30a7437cd73f2aaf4228d764ea3dd`.

## Independent executions

| Execution | Result | Receipt |
| --- | --- | --- |
| Frozen `regression_frozen.py`, actual script via runpy | exit 0; 6/6 OK; 0.021s | `critic-runpy-regression-new.log` |
| Frozen `critic_caller_probe.py`, actual script via runpy | exit 0; 2/2 OK; 0.089s | `critic-runpy-caller-new.log` |
| Strict owner regression, separately | exit 0; 1/1 OK; 0.020s | `critic-strict-new.log` |

Strict command, from `owner/python/omp-rpc`:

```sh
PYTHONPATH=src python3 -B -m unittest -v tests.test_client.RpcClientTests.test_oversized_event_never_replays_previous_turn_terminal
```

Also reviewed the coordinating run's `regression-new.log`, `caller-new.log`, `strict-new.log`, and `adjacent-new.log`. They report 6/6, 2/2, 1/1, and 72/72 OK respectively. The adjacent suite was not rerun by this critic. Its 72 already include the strict case, so the counts should not be summed as unique tests.

## What the results establish

The repair evicts the retained prefix before incrementing the offset for an oversized frame. Therefore old retained events cannot receive indices after the dropped frame. The tested second prompt's captured index falls behind the new offset, and the real waiter raises the history-limit error before considering a previous terminal event. The frozen six-case replay covers ordinary eviction and small-event controls, an oversized first frame, a retained old terminal followed by a gap, a small event after the gap, and the real waiter. The public-caller fixture covers parsed notifications and two public prompts over real local subprocess pipes without mocking client methods.

The frozen caller and waiter assertions permit either `RpcError` or `RpcTimeoutError`; additionally, `RpcTimeoutError` subclasses `RpcError`. Their passes alone establish that the reproduced stale terminal is no longer returned, not the precise overflow semantics. The owner's separate assertion requires `RpcError` matching `Event history limit was exceeded`, and passes. That supplies the stronger evidence for the README's history-limit behavior in this scenario. No substantive mismatch was found among these scoped claims.

## Limits and attribution

The demonstrated budget is 60 bytes. Default-budget impact, RSS/memory behavior, live Bun/application/native-addon/provider/model behavior, full-suite compatibility, and baseline newness remain unverified by this critic. Snapshot assertions are evidence for this owner's representation, not a universal requirement for every possible repair. No source edit, installation, credentials access, commit, push, posting, merge, or production change was performed.

Ownership and implementation credit remain with roboomp. Kevin retains credit for the earlier diagnostic work; dot retains credit for the original independent probe. This critic contributes independent acceptance replay only.

The coordinator reports a final remote refresh with unchanged roboomp ownership and the expected head; this critic made no independent remote freshness request. At original review time the coordinator had not located the canonical claim ledger; that historical caveat remains part of the original review. Subsequent coordinator read issue #53 and linked claims, finding no observed conflicting claim for this replay; see README.md. This follow-up does not change the original substantive critic verdict. This receipt grants no publication or implementation-ownership permission.
