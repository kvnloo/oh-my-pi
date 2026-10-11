# PII example: Cursor wire compatibility

**LIMITED:** Node 24.19.0 source-module / real protobuf acceptance only.
**HOLD:** upstream promotion pending supported Bun/native checks and required human review.

Kevin Rajan implemented the extension in [PR #10829](https://github.com/can1357/oh-my-pi/pull/10829).
The original typed-array diagnosis is the [automated Codex review](https://github.com/can1357/oh-my-pi/pull/10829#discussion_r3970045720).
Codex prepared this narrow downstream patch and evidence; no human review or DCO certification is claimed.

Base and freshly confirmed owner head: `a4dd7b79ed88313a11ad05b76ab206ca5435b247`.
Owner branch: `kvnloo/oh-my-pi:feat/paw-pii-extension-example`.
Isolated candidate: `fix/pii-cursor-wire-20261011`.
Pre-publication refresh found that candidate branch absent, all fork branch names/heads unchanged,
no competing PII claim or related PR from issue/PR body and comment searches, and the finding unresolved/non-outdated.
The existing owner branch is untouched. This is a new downstream branch publication, not upstream submission.

## Requirement and scope

Cursor passes the `onPayload` replacement directly into its outgoing request.
`ConversationStateStructureSchema.rootPromptMessagesJson` is repeated bytes;
`toBinary(AgentClientMessageSchema, ...)` rejects values other than `Uint8Array` through `requireBytes`.
The previous object walk produced numeric-key plain objects. The fix returns `Uint8Array` before object traversal.
It does not change provider behavior, PAW batching, arbitrary object handling, or other review findings.
The changelog entry records the user-visible example compatibility fix required by repository instructions.

The regression captures the handler registered by the actual extension factory, then runs real
`create`, `toBinary`, and `fromBinary` through `AgentClientMessageSchema`, `AgentRunRequestSchema`, and
`ConversationStateStructureSchema`. It checks exact standalone/subview bytes `[1, 2, 255]`, excluding backing
sentinels `[99, ..., 88]`, including the bytes-valued map entry `fileStates.fixture` and its string key.
Sibling textual email is redacted. Nested JSON email/SSN leaves are redacted while null/boolean/number controls
are preserved. Input snapshots and complete backing bytes remain unchanged.

The returned byte view is the same object: no copying or mutation, identical offset/length/backing storage.
It aliases mutable input storage; subsequent consumer writes can affect that storage. Buffer is compatible
by inheritance but **untested**. Opaque bytes are **unsanitized**, including the fixture's encoded email.
Blob contents, arbitrary objects, repeated-reference redaction and broader privacy guarantees are outside scope.

## Replay from repository root

No dependencies or native addon are generated or installed. The loader resolves complete repository source
modules; it does not extract functions, patch source, or mock protobuf. Node's experimental TypeScript
transform handles enums. `bun:test` resolves to `node:test`, catalog aliases resolve to their real modules,
and the `pi-utils` barrel is narrowed to its actual `type-guards.ts`. Type-only imports are erased.
The registration harness bypasses ExtensionRunner and extension loading. **No live Cursor request** was run.

```sh
# GREEN: exit 0, 2 pass / 0 fail
node --experimental-transform-types --import ./evidence/pii-cursor-wire/node-source-loader.mjs \
  --test packages/coding-agent/test/pii-redact-cursor-wire.test.ts

# RED: same final test, original complete extension; exit 1, 0 pass / 2 fail
baseline_dir=$(mktemp -d)
baseline_source="$baseline_dir/pii-redact.ts"
trap 'rm -f "$baseline_source"; rmdir "$baseline_dir"' EXIT
git show a4dd7b79ed88313a11ad05b76ab206ca5435b247:packages/coding-agent/examples/extensions/pii-redact.ts > "$baseline_source"
OMP_PII_BASELINE_SOURCE="$baseline_source" node --experimental-transform-types \
  --import ./evidence/pii-cursor-wire/node-source-loader.mjs \
  --test packages/coding-agent/test/pii-redact-cursor-wire.test.ts
```

Recorded RED reached `protobuf.ts:641` and threw `Error: Expected Uint8Array`; the opaque-byte assertion
also observed a numeric-key object. Recorded GREEN passed both tests. Node v24.19.0 emitted the expected
experimental-transform warning. The portable loader differs from the initial evidence loader only in
root/baseline path resolution; replay was rechecked after that packaging change.

Four adjacent source helper checks (recorded: four pass):

```sh
node --experimental-transform-types --import ./evidence/pii-cursor-wire/node-source-loader.mjs --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {buildPawArgs,mapTextBlocks,redactStructuredPayload,regexRedact} from './packages/coding-agent/examples/extensions/pii-redact.ts';
assert.deepEqual(buildPawArgs('hi','[PII]'),['--placeholder','[PII]','redact','--text','hi']);
assert.equal(regexRedact('mail a@b.co phone 555-123-4567 ssn 123-45-6789','[PII]'),'mail [PII] phone [PII] ssn [PII]');
assert.deepEqual(mapTextBlocks([{type:'text',text:'a@b.co'},{type:'image',url:'fixture'},{type:'text',text:'555-123-4567'}],s=>regexRedact(s,'[PII]')),[{type:'text',text:'[PII]'},{type:'image',url:'fixture'},{type:'text',text:'[PII]'}]);
assert.deepEqual(redactStructuredPayload({tools:[{arguments:{cmd:'echo 123-45-6789'}}]},'[PII]'),{tools:[{arguments:{cmd:'echo [PII]'}}]});
console.log('PASS: 4 adjacent source helper assertions (bounded Node, not Bun suite)');
JS
git diff --check
sha256sum -c evidence/pii-cursor-wire/SHA256SUMS
```

`git diff --check` passed. `bun --version` failed with exit 127: Bun is unavailable.
Supported workspace Bun is 1.4.0; runtime floor is 1.3.14. No source-matched pi-natives addon was found.
No Bun download, canceled effect/drizzle probe, live model credentials or security changes were attempted.
Supported Bun tests, `bun check`, native graph loading, ExtensionRunner integration and live Cursor acceptance
remain unverified. Current contribution rules allow focused downstream preparation, but upstream submission
requires human inspection, a human-written explanation and relevant verification; this packet does not waive those gates.

## Independent review and identities

A separate explicitly requested **xhigh critic agent** read AGENTS/CONTRIBUTING, the full patch/test and evidence
loader/packet, independently reran RED/GREEN with 15-second caps under Node24.19, verified baseline source identity,
and checked whitespace. Result: no blocking findings within this scope; **LIMITED / LOCAL_ONLY**.
It confirmed subview order makes the repeated-reference bypass irrelevant to the RED path, and highlighted
shared mutable storage and opaque unsanitized bytes. It did not claim human or supported Bun acceptance.

Original extension Git blob: `49c349f3e64a1ea3a7d890dfb4fba1a2fba2ebbd`.
Fixed extension: `514a6f2d4942ce39185539b9b73e41273c4813eb`.
Regression: `c4ca1770b59195f41ca78f5b47187be0ffd1ccb1`.
SHA256SUMS pins the changed files, portable evidence and actual codec/provider/type-guard source.
The manifest excludes itself to avoid a circular hash; its Git blob is available from this commit.
The earlier detailed sanitized Library packet is `libfile_f06a1c36f46c81919fe25ee95020b044`.
