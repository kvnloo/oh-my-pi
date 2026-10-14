# OMP155: Python host-tool rejection repair

Downstream-only, independently reviewed implementation evidence for
[claim 155](https://github.com/kvnloo/oh-my-pi/issues/155).
Base: `f5145fd0271906cdf3bca6a218912fa1d8db3500`, root tree
`afa6173ec346bd515c5b6cdc9ee22a00ad776275`.

## Result and boundary

The Python SDK replaces local callable handlers before asking the server to
replace registered tools. A definite rejection previously left the rejected
handlers installed locally. A subsequent server callback for the accepted tool
then failed or called the wrong same-name handler. This is reproduced through
the actual SDK and disposable Python subprocess pipes.

Final V2 restores the latest non-rejected registration before dispatching a
following callback. Publication uses actual wire-send order. No registration
lock spans a response wait, so pre-ACK callbacks can register tools themselves.
An accepted or uncertain outcome anchors subsequent replacements and drops
predecessor history. Only unresolved registration chains are retained. A real
SIGINT, timeout or disconnect is uncertain, not a confirmed server rejection;
those outcomes do not roll back possibly applied server state. Literal
`success=False` is the rejection boundary.

This is **LIMITED: Python SDK native execution**, not Bun-server integration,
provider testing, a full OMP build, a production-user incident, or origin-ready
approval. The fake peer supplies deterministic acceptance/rejection ordering;
it does not prove every server error leaves the entire bridge unchanged.

## Requirement and semantic risk

- [Documented host-tool replacement and uniqueness contract](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/docs/rpc.md#L735-L780).
- [Empty-description rejection before bridge/session mutation](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L977-L1000).
- [Setter ordering](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L2136-L2140).
- [Session validation and failed-rebuild registry restoration](https://github.com/can1357/oh-my-pi/blob/f5145fd0271906cdf3bca6a218912fa1d8db3500/packages/coding-agent/src/session/session-tools.ts#L2254-L2305).

The supported path is runtime Python host-tool replacement. Rejection must not
make the still-registered accepted callable unavailable. Server bridge mutation
precedes session validation in some failure paths; this patch does not change
server mutation semantics or claim a full atomic server transaction.

General late-response request-ID fallback behavior tracked by origin
[#12555](https://github.com/can1357/oh-my-pi/pull/12555) remains unchanged.
Its unmatched identified response must not additionally roll back a newer tool
registration. General interrupted pending-request cleanup also remains out of
scope. Those existing behaviors are described in the independent review.

## Executed evidence

Python 3.12.14, pytest 9.1.1, Ruff 0.17.0. The latter two were reused from an
already provisioned environment. A prior install invocation failed before pip
started; it was not retried and no protected paths were modified.

- Frozen regression: baseline 15 methods, 7 failure records and 1 error;
  candidate all 15 methods pass. Counts include distinct subtest branches.
- Original full SDK baseline: 107 passed, 34 subtests passed.
- Full candidate SDK: 122 passed, 38 subtests passed. Independent rerun agrees.
- Independent adjacent unittest run: 104 tests pass.
- Original independent SIGINT and pre-ACK nested registration probes now pass.
- Independent helper model: 405 three-registration ordered-send/outcome traces
  pass, plus explicit False versus falsey/missing response checks. This model is
  supplemental state coverage, not 405 native integration tests.
- New regression test Ruff check and format pass. Whole-SDK lint is **not green**:
  both arms have the same 42 normalized pre-existing diagnostics and six
  original files with formatting differences. See `static-checks.json`.
- The committed replay runner was itself exercised with `--pytest` against the
  hash-checked baseline snapshot and frozen candidate; all its outcome guards
  passed (`logs/packet-replay.log`). Its Ruff check and format also pass.

The test covers initial registration, accepted replacement, same-name callable
restoration, rejection before immediate callback, empty-set restart, pre-ACK
callback, ambiguous timeout/disconnect, malformed success, ID-less rejection,
late identified responses, concurrent outcomes, both rejection orders, actual
SIGINT (including reused tuple), nested registration, and reversed caller versus
wire ordering. Signal tests target a disposable subprocess only.

## Reproduce without installing anything

From a checkout of this branch, use Python 3.11+ (3.12.14 was tested). The base
Git object must already be available locally; the runner does not fetch it.
The output directory must be new. `--pytest` is optional and requires pytest
already available in the selected interpreter.

```sh
python3 -B evidence/python-host-tool-rejection-20261014/run_evidence.py \
  --candidate sdk/python/omp-rpc --output /tmp/omp155-new-run --pytest
```

For a verified source snapshot without Git metadata, pass `--baseline` pointing
to the pinned base SDK directory. Every baseline file is checked against the
Git-blob manifest; unchanged candidate files must match it. Frozen final client
and regression-test SHA-256 guards prevent mixing versions. The runner creates
only its new output directory and disposable baseline copy, runs the expected
RED/GREEN and adjacent controls, and invokes all three independent probes.

## Evidence map and rejected design

`final-v2.patch` is the only final implementation patch. `review/approved-v2.md`
records the independent no-blocker verdict. `logs/` contains captured results;
`log-provenance.json` records hashes before and after path-only sanitization.
In the original reviewer report, `candidate-v2-pytest.log` maps to
`logs/reviewer-sdk-pytest.log`; probe logs map to the corresponding
`logs/reviewer-*.log`. The frozen source/test hashes are in `run_evidence.py`.

`rejected-v1/` preserves a **rejected** earlier design and its negative review.
It held a registration lock across I/O waiting. Independent actual SIGINT and
reentrant-callback probes found stale rollback and lock-induced timeout
regressions. Neither that patch nor its earlier green headline is the final
candidate. Both original independent reproducers remain runnable in `review/`.

## Ownership, provenance and promotion holds

This is a new leaf, separate from downstream #151 URI rollback, #152 startup
cleanup, and #153 composition. Their branches are untouched; #151's failed
release write remains on its no-retry hold. Overlap review preserves
marcelojmontanez's #12555 request-ID work, roboomp's #12842 retention work,
andrebrait's #14166/#14468 session-host work, and anthonyrisinger's #15300 URI
response work. Shared request plumbing will need composition review if those
changes land. Large older PRs whose patches were unavailable were not declared
fully overlap-cleared.

Existing OMP/Python SDK implementation credit remains with can1357 and Sunil
Srivatsa and the upstream contributors. Repair and tests are agent-authored;
the separate critic supplied the two blocking V1 reproducers, outcome model,
and independent V2 review. GitHub connector commit attribution is not a human
review or signoff. No DCO/CLA certification is made.

Origin remains held: current factory-owned PRs have outstanding review findings,
CI/policy gates, or conflicts. CONTRIBUTING/AGENTS require human full-file review,
personally exercising the path, and a contributor-written sentence before a
contributor PR. This downstream evidence does not satisfy those human gates or
authorize origin actions. No upstream writes or default-branch updates occurred.

Process gap: the initial downstream claim issue was created before applying the
repository's exact-text human-confirmation rule for issue/comment publication.
It is preserved rather than deleted or silently rewritten. The subsequent
result comment is held for exact-text human approval, and no draft PR was opened
without the required contributor sentence and human review.
