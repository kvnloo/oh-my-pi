import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertReviewed, digest, MAX_BYTES, normalize, prepare, visibleChildren } from './core.mjs';
import { loadPrior } from './prior.mjs';

const leaf = (id = 'a', code = 10, churn = 2) => ({ id, label: `${id}.ts`, code, churn });
const json = (children = [leaf()]) => JSON.stringify({ version: 1, title: 'Synthetic fixture', root: { id: 'root', label: 'repo', children } });
const renderer = digest('reviewed renderer');
test('computes group totals and is deterministic', () => {
  const a = prepare(json([leaf(), leaf('b', 30, 5)]), renderer);
  assert.equal(a.document.root.code, 40); assert.equal(a.document.root.churn, 7);
  assert.deepEqual(a, prepare(json([leaf(), leaf('b', 30, 5)]), renderer));
});
test('changed data or renderer changes preview identity', () => {
  assert.notEqual(prepare(json(), renderer).id, prepare(json([leaf('a', 11)]), renderer).id);
  assert.notEqual(prepare(json(), renderer).id, prepare(json(), digest('new')).id);
});
test('rejects oversized JSON before parsing', () => assert.throws(() => normalize('x'.repeat(MAX_BYTES + 1)), /byte limit/));
test('rejects duplicate ids', () => assert.throws(() => normalize(json([leaf(), leaf()])), /duplicate/));
test('rejects executable extra fields', () => assert.throws(() => normalize(json([{ ...leaf(), script: 'do not run' }])), /Unexpected/));
test('plain markup remains inert label data', () => assert.equal(normalize(json([{ ...leaf(), label: '<b>data</b>' }])).root.children[0].label, '<b>data</b>'));
test('rejects terminal control characters', () => assert.throws(() => normalize(json([{ ...leaf(), label: '\u001b[2J' }])), /label/));
test('rejects negative, fractional and non-finite values', () => {
  for (const value of [-1, 0.5, Infinity, NaN]) assert.throws(() => normalize(json([leaf('a', value)])), /numeric/);
});
test('rejects invalid children and incorrect aggregate', () => {
  assert.throws(() => normalize(json([{ ...leaf(), children: {} }])), /children/);
  assert.throws(() => normalize(json([{ id: 'g', label: 'g', code: 55, children: [leaf()] }])), /aggregate/);
});
test('depth is bounded', () => {
  let node = leaf();
  for (let i = 0; i < 18; i++) node = { id: `g${i}`, label: 'g', children: [node] };
  assert.throws(() => normalize(json([node])), /bounds/);
});
test('projection has an explicit bounded Other group without losing totals', () => {
  const root = normalize(json(Array.from({ length: 1000 }, (_, i) => leaf(`f${i}`, i + 1)))).root;
  const visible = visibleChildren(root);
  assert.equal(visible.length, 128); assert.equal(visible.at(-1).children.length, 873);
  assert.equal(visible.reduce((sum, n) => sum + n.code, 0), root.code);
  assert.equal(visibleChildren(visible.at(-1)).length, 128);
});
test('zero-weight data remains valid; invalid projection modes fail', () => {
  const root = normalize(json([leaf('zero', 0, 0)])).root;
  assert.equal(visibleChildren(root)[0].code, 0);
  assert.throws(() => visibleChildren(root, 'exec'), /projection/);
});
test('publication rejects absent or self-reported verification', () => {
  const a = prepare(json(), renderer);
  assert.throws(() => assertReviewed(a, undefined, 's1', renderer), /inspection/);
  assert.throws(() => assertReviewed(a, { id: a.id, scope: 's1', rendererHash: renderer, method: 'agent-says-pass' }, 's1', renderer), /inspection/);
});
test('human receipt is revision, renderer and session bound; repeated publication is stable', () => {
  const a = prepare(json(), renderer), receipt = { id: a.id, rendererHash: renderer, scope: 's1', method: 'human-inspected' };
  assertReviewed(a, receipt, 's1', renderer); assertReviewed(a, receipt, 's1', renderer);
  assert.throws(() => assertReviewed(a, receipt, 's2', renderer), /inspection/);
  assert.throws(() => assertReviewed(a, receipt, 's1', digest('changed')), /inspection/);
  assert.throws(() => assertReviewed(prepare(json([leaf('different')]), renderer), receipt, 's1', renderer), /inspection/);
});
test('reads one bounded OpenDesign package and rejects escaping source files', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'native-prior-'));
  const dir = path.join(parent, 'selected'); await fs.mkdir(dir);
  try {
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schemaVersion: 'od-design-system-project/v1', id: 'test', source: { type: 'fixture' }, files: { design: 'DESIGN.md', tokens: 'tokens.css' } }));
    await fs.writeFile(path.join(dir, 'DESIGN.md'), 'A'.repeat(13000));
    await fs.writeFile(path.join(dir, 'tokens.css'), ':root{--accent:blue}');
    const prior = await loadPrior(dir);
    assert.equal(prior.truncated, true); assert.equal(prior.designExcerpt.length, 12000);
    assert.equal(prior.id, 'test'); assert.equal(prior.hash.length, 64);
    await fs.unlink(path.join(dir, 'DESIGN.md'));
    await fs.writeFile(path.join(parent, 'outside.md'), 'outside');
    await fs.symlink(path.join(parent, 'outside.md'), path.join(dir, 'DESIGN.md'));
    await assert.rejects(loadPrior(dir), /escapes/);
  } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
test('fixture and static plugin guardrails (not Luau execution or visual verification)', async () => {
  const plugin = new URL('./tern/', import.meta.url);
  const host = await fs.readFile(new URL('host.luau', plugin), 'utf8');
  assert.doesNotMatch(host, /tern\.(fetch|process|timer)|loadstring\(|require\(/);
  const css = await fs.readFile(new URL('visual.css', plugin), 'utf8');
  assert.ok(css.trim().split('\n').every(line => line.startsWith("[data-surface='plugin.native-visual.reply']")));
  const fixture = JSON.parse(await fs.readFile(new URL('demo.visual.json', plugin), 'utf8'));
  assert.equal(fixture.schema, 'omp-native-visual/v1');
  assert.equal(normalize(JSON.stringify(fixture.document)).root.children.length, 3);
});
