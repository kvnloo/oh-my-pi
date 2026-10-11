# PR #12842 owner repair: independent acceptance

LIMITED / PASS for the bounded stale-terminal repair. Evidence-only preparation by OpenAI Codex at Kevin's instruction; no signoff or whole-PR approval.

Tested owner head: `7fa2a00b511b6ce6bbc83feb5cb2a5f501020968`; direct repair parent: `f483ffeb8f029474e37c5c826dd4a983b3de1e1e`. Implementation and repair ownership remain roboomp's. Kevin retains earlier diagnostic credit; dot retains original probe credit. OpenAI Codex contributes acceptance replay only.

Frozen packet: [immutable commit 8458c8bc826f4c033335ab63a38205baa9c5dd38](https://github.com/kvnloo/oh-my-pi/tree/8458c8bc826f4c033335ab63a38205baa9c5dd38/docs/reviews/omp-12842-stale-terminal-20261010). No packet copied or altered here. All eight manifest entries verified; independent critic compared all nine files to committed blobs, byte-identical. Packet has no `source/python/omp-rpc/src` shadow directory or symlink. Its historical expected failures concern the old head, not this repair.

Python **3.12.14**, standard library only. Substitute existing absolute paths for OWNER_CHECKOUT (exact tested owner checkout) and PACKET (unchanged frozen packet). Commands executed from the owner's Python package:

```sh
cd "$PACKET"
sha256sum -c SHA256SUMS
cd "$OWNER_CHECKOUT/python/omp-rpc"
PYTHONPATH=src python3 -B "$PACKET/regression_frozen.py"
PYTHONPATH=src python3 -B "$PACKET/critic_caller_probe.py"
PYTHONPATH=src python3 -B -m unittest -v tests.test_client.RpcClientTests.test_oversized_event_never_replays_previous_turn_terminal
PYTHONPATH=src python3 -B -m unittest -v tests.test_client tests.test_protocol tests.test_host_uris
PYTHONPATH=src python3 -B -c 'import omp_rpc, omp_rpc.client; print(omp_rpc.__file__); print(omp_rpc.client.__file__)'
```

Actual results: frozen 6/6 OK (0.023s); caller 2/2 OK (0.103s); strict owner 1/1 OK (0.021s); adjacent 72/72 OK (2.709s). The strict case is included in the 72: **not 81 distinct owner tests**. Coordinator shell exited 0; individual command exits were not separately retained, so each pass is supported by its captured unittest OK summary. Independent critic propagated exit codes: 6/6 exit 0 (0.021s), 2/2 exit 0 (0.089s), strict 1/1 exit 0 (0.020s). Critic reviewed adjacent log without rerunning 72. No tests rerun to prepare this evidence commit.

Actual scripts executed with runpy by the independent xhigh critic resolve every loaded `omp_rpc` module under `$OWNER_CHECKOUT/python/omp-rpc/src/omp_rpc/`; caller's inserted packet-shadow path is absent. Separate coordinating provenance also resolves package `__init__.py` and `client.py` there.

Claim/overlap preflight: read current factory AGENTS.md/CONTROL_PLANE, canonical [issue #53](https://github.com/kvnloo/oss-factory/issues/53) and linked operating documents. Its 52 fetched comment records have no #12842/new-head/stale-terminal/omp-rpc claim; explicit current leases concern separate z0intelligence/supervisor/dependency work. Parent reports another read-only qualifier identified the owner repair and launched no second replay worker. No equivalent new-head acceptance found in checked fork issues/PR comments or upstream PR conversation/reviews/inline reviews; existing frozen evidence branch still points to 8458c8bc. No observed conflict, no claim to implementation ownership. Search indexing can lag; refresh before subsequent publication.

## Limits

The repair evicts the retained prefix before advancing an oversized-frame gap, preventing previous-turn terminal replay in the demonstrated **60-byte** configuration. Frozen caller accepts timeout or RpcError; RpcTimeoutError subclasses RpcError. Its pass alone does not establish overflow semantics. The separate strict owner regex requires `Event history limit was exceeded` and passes.

No default-budget impact, RSS/memory measurement, live Bun/application/native-addon/provider/model behavior, broad full-suite compatibility, baseline-newness or efficacy/cost-savings claim. No source changes, paid inference experiment or personal-computer use. Only authorized repair parent-to-head inspection performed; prohibited base-to-old-head diff neither requested nor reconstructed. Earlier wrong-CWD repeat checksum invocation failed to resolve relative paths; corrected packet-CWD invocation and initial correct verification both passed all eight entries.

This commit is downstream evidence under a specific one-branch ordinary-push lease; it grants no upstream post, PR, default merge or production authority.

## SHA256 provenance

Frozen packet entries (verified against immutable packet; not duplicated files):

```text
7c618f9c1c77d8d18e00df2297b32b7c9e868b683b14ed608102d448e7da8d37  CRITIC.md
38b76b95dca880c1e7e3218f58e2772ccd81cbd0a889c3c7e240ce289aee5274  OWNER_HANDOFF.md
b5b1f9453e2eac9a2a085a65ec56a73b9909724b4e198ef5b0706aee255de1fe  README.md
be494c575591b4b267af74fea97bed328ec13069b55347ed4e2e029f5979e8e2  critic-caller-probe.log
b80836af79b01d5b2347191c2c513ba81b01d2dfcb941c422d52b30224c84821  critic-owner-suite.log
8862fbf53dcafcd807ab84cd6dfd8d97ec21c914eff6623ad7663a86c2390e1e  critic-regression.log
7ffc9f3dfa6c02e8c54b0ef16cd665f1ac329e6f4e1361c063f280ecf53c3421  critic_caller_probe.py
3fe19376afda82ea4010139de6c29b6862b72362b2d4b4ff04a7ce66b4e4f245  regression_frozen.py
19861fc98cc9100580ed098e8da0b1f3ae362e850bd2c5f271f3dc60823ea85a  SHA256SUMS
```

Imported owner modules, relative to `python/omp-rpc/src/omp_rpc/`:

```text
9a9d69fca3956cbe8004309670f7ff430a677de34999976df7cd242913cf2f69  __init__.py
fbe81bed89ca85af9928ac5f081dea0f27c30a7437cd73f2aaf4228d764ea3dd  client.py
3e2f1683dc1d87294c516ff0507e2704cb01770a440b6717ab6bf075ef03610d  protocol.py
7e0036b1fcf5fdedec9c7011d6a428a9dd0de670d4ed700aa9d788dad35b4797  host_tools.py
2b5c73c6ca528d2be705e6020c1768856fd76b67641eafd33109dbacbed63ade  host_uris.py
```
