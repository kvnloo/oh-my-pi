# Reproduce owner-safe evidence: omp-12842

Verdict: PASS for bounded evidence only. Head: `f483ffeb8f029474e37c5c826dd4a983b3de1e1e`.

Use an existing owner checkout at that exact head. Set OWNER_CHECKOUT to its absolute path and PACKET to this evidence directory's absolute path. The full unchanged owner Python package is imported from the checkout. No production code is bundled.

```sh
cd "$OWNER_CHECKOUT/python/omp-rpc"
PYTHONPATH=src python3 -B -m unittest -v tests.test_client tests.test_protocol tests.test_host_uris
PYTHONPATH=src python3 -B "$PACKET/regression_frozen.py"
PYTHONPATH=src python3 -B "$PACKET/critic_caller_probe.py"
```

Expected results: 71 pass (exit 0); 3 pass / 3 fail (exit 1); 1 pass / 1 fail (exit 1), respectively.

Read CRITIC.md for the contract, attribution, and test limitations. OWNER_HANDOFF.md describes the proposed owner handoff, not an external message already sent.

The original test scripts are unchanged. The included log files are sanitized copies: absolute local paths in traceback frames were shortened to filenames; result lines and assertions are unchanged. No private operational metadata is included.

These checks establish the cited current-head behavior. They do not establish baseline newness or a whole-application gate. Coordinating review refreshed both remote heads and owners after the rate-limit window and reported them unchanged before packaging; the independent critic itself made no remote freshness request. Refresh again before any later publication.
