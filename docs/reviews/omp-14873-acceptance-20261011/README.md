# Independent queue-retry acceptance for OMP PR #14873

Owner implementation: [roboomp's PR #14873](https://github.com/can1357/oh-my-pi/pull/14873).
This packet independently verifies the owner's implementation. It contains test-only acceptance evidence, not a competing fix or a new defect report. No owner production file, branch, PR, or upstream discussion was changed.

## Conclusion

**Scoped acceptance PASS at exact head `5159214780de85b8aee65a39a7b30760f3313a57`.** The queue family and independent probes passed **20 tests in 8.36 seconds** using the portable runner. On exact direct parent `3e3c488a58d294e3a10051da588628e2cfb9d35c`, both the original frozen recovery test and the strengthened recovery test failed as expected: the dispatcher crashed on the first injected claim error, leaving the prequeued event undelivered (**2 expected failures in 8.35 seconds**).

This is a pinned-commit result. It does not assert the current live PR status, CI status, merge readiness, or full-server acceptance. The historical PR API base `2e5311bb6eb824fedca5e84f49c292ca6957acc3` was not used as the RED control.

## Provenance and isolation

- Local Git objects verify that the RED commit is the candidate's immediate parent.
- All 135 tracked files in the candidate's `python/robomp` archive and all 134 files in the parent archive matched their commit blobs. The checks were repeated after the initial final test run.
- The existing local RPC dependency's nine source files match both commits. The portable runner revalidates archive and RPC bytes before testing.
- Runtime origin checks verified every loaded `robomp`, `tests`, and `omp_rpc` module in the portable replay came from the selected archive or matching dependency source. No head/parent module mixing was detected.
- The runner denied socket connections and DNS lookups. **Zero outbound attempts** were observed in every replay. Only the five named queue-test files may be selected; broad server tests are rejected.
- Python 3.12.14, pytest 9.1.1, and pytest-asyncio 1.4.0 were already available locally. No installs, fetches, new worktrees, or downloads were performed. `GIT_NO_LAZY_FETCH=1` was set for Git reads.

## What the tests establish

The original frozen independent file is unchanged: SHA-256 `04520577eea03d6708ceac6daedb20f95dc8cdf40ec2e6d8a718f88f26f406f6`. It recovers a prequeued event after two consecutive injected `sqlite3.OperationalError` failures and checks a real SQLite claim count of one. Its separate public-stop test passes at the candidate.

The strengthened test file has SHA-256 `5c198d2cdd4533f2efc8d5ad60f338d376d820035e935f70f25a50488655a551` and closes two evidence gaps:

1. **One real claim and one task invocation.** After two failures, the wrapper delegates to the real SQLite claim. It records exactly one returned delivery, one task-stub call, `state == "done"`, and `attempts == 1`. Re-inserting the same delivery is rejected by the real database deduplication guard. Three explicit queue rescans and final shutdown produce no duplicate task call.
2. **Shutdown while retry backoff is active.** A persistent failure is observed in the dispatcher error handler, followed by an event-loop yield while the dispatcher remains alive and claim count remains one. Public `stop()` finishes within 0.5 seconds, leaves the event queued with zero successful claims, and permits no task call or subsequent claim beyond the one-second retry deadline.
3. **Stop-aware waiting independently of cancellation.** A second shutdown case sets the dispatcher's stop signal directly and never cancels the task. The dispatcher exits normally within 0.5 seconds, with no exception or cancellation, and the same queued-state/no-later-claim assertions hold. This internal lifecycle probe distinguishes the stop-aware backoff from the cancellation performed by public `stop()`.

The final 20-test gate comprises seven dispatch-mapping cases, six existing graceful-shutdown cases, two owner-authored recovery/readiness cases, two original frozen independent cases, and three strengthened cases. The original 17-test set was independently replayed before the stronger probes were added.

## Limits

- Claim errors are injected at the database boundary. Subsequent claims and event transitions use real temporary SQLite, but actual cross-process SQLite lock contention was not exercised.
- Task bodies are in-process stubs. The exactly-once observation applies to claims and task invocations in these scenarios; it is not a general exactly-once guarantee for GitHub mutations, processes, crashes, or external side effects.
- The 0.5-second shutdown bound and the observation beyond the one-second retry deadline are local test results, not a production latency SLA.
- A previous wider server run was inconclusive: 68 tests passed and two unmocked external-client paths failed under the environment's proxy/dependency setup. It is not counted as a server-suite PASS and was not rerun for this review.
- Persistent-database-outage readiness was already under separate review and is outside this packet's acceptance and novelty claims.
- The portable candidate run emitted one existing FastAPI/Starlette deprecation warning. Earlier local-runner logs also contain a pytest plugin import-order warning; the portable replay avoids that runner-only warning.

## Portable replay

Use already available dependencies, the two exact isolated source archives, and an existing local repository containing the commit objects. Do not point the runner at an owner checkout. It refuses a Git checkout root, verifies the archive's tracked files, and adds only the two included independent test files. Nothing is posted upstream.

Candidate gate:

```sh
python3 -B run_acceptance.py \
  --archive "$HEAD_ARCHIVE" \
  --git-source "$LOCAL_REPOSITORY" \
  --commit 5159214780de85b8aee65a39a7b30760f3313a57 \
  --rpc-src "$MATCHING_RPC_SOURCE" \
  --tests tests/test_queue_dispatch.py tests/test_queue_shutdown.py \
          tests/test_dispatch_recovery.py tests/test_independent_claim_recovery.py \
          tests/test_critic_acceptance.py
```

Direct-parent RED controls:

```sh
python3 -B run_acceptance.py \
  --archive "$PARENT_ARCHIVE" \
  --git-source "$LOCAL_REPOSITORY" \
  --commit 3e3c488a58d294e3a10051da588628e2cfb9d35c \
  --rpc-src "$MATCHING_RPC_SOURCE" \
  --tests tests/test_independent_claim_recovery.py::test_queued_event_survives_two_claim_errors \
          tests/test_critic_acceptance.py::test_retry_delivers_one_real_claim_and_one_task_call
```

If test dependencies are available in unpacked local caches rather than the interpreter's normal import path, pass one `--dependency-path "$EXISTING_PACKAGE_DIRECTORY"` option per needed directory before `--tests`. The runner does not install anything. Parent exit code 1 with the two named recovery failures is the expected RED result; an import/setup error is not.

## Contents

- `test_independent_claim_recovery.py`: unchanged original frozen test
- `test_critic_acceptance.py`: strengthened exactly-once and shutdown probes
- `run_acceptance.py`: local-only identity-checking replay runner
- `source-identities.json`: exact source checks
- `results.jsonl`: result rows with exact commits and test summaries
- `*-portable-runner.log`: primary head/parent replay outputs
- Other logs: the preceding independent replays
- `SHA256SUMS`: integrity hashes for every other packet file

Captured outputs preserve result lines and tracebacks with local absolute paths normalized. Operational details unrelated to these local-only tests are excluded.

## Evidence authorship

Implementation and original regression credit: roboomp. Additional acceptance fixtures and independent review were prepared by dot, an OpenAI AI assistant. This packet does not assert a human DCO or CLA attestation.
