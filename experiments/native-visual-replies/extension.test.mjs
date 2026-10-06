import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import nativeVisualReplies from './extension.ts';
import * as io from './tests/extension-io.mjs';

let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-lifecycle-')); io.reset(); });
afterEach(async () => { io.reset(); await fs.rm(root, { recursive: true, force: true }); });
const data = (value = 10) => JSON.stringify({ version: 1, title: 'Synthetic test', root: { id: 'r', label: 'repo', code: value, churn: 1 } });
function host() {
  const tools = new Map(), commands = new Map(), events = new Map(), notices = [];
  const state = { owner: 'session-a', confirm: async () => true };
  const field = { describe() { return this; } };
  const ctx = { mode: 'tui', sessionManager: { getSessionId: () => state.owner },
    ui: { confirm: (...args) => state.confirm(...args), notify: (...args) => notices.push(args) } };
  nativeVisualReplies({ zod: { string: () => field, object: shape => shape }, pi: { getAgentDir: () => root },
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (id, command) => commands.set(id, command),
    on: (event, fn) => events.set(event, fn) });
  return { state, ctx, notices, events,
    preview: (json = data(), signal) => tools.get('visual_preview').execute('p', { json }, signal, undefined, ctx),
    publish: (id, signal) => tools.get('visual_publish').execute('q', { id }, signal, undefined, ctx),
    approve: id => commands.get('visual-approve').handler(id, ctx) };
}
const sourceRead = file => file.endsWith('host.luau');
const mutations = () => io.calls.filter(call => ['mkdir', 'writeFile'].includes(call.method));

test('registration performs no IO', () => { host(); assert.equal(io.calls.length, 0); });
test('publishes the exact inspected file, without re-generation', async () => {
  const h = host(), p = await h.preview();
  await assert.rejects(h.publish(p.details.id), /inspection/);
  await h.approve(p.details.id);
  const bytes = await fs.readFile(p.details.file, 'utf8');
  const result = await h.publish(p.details.id);
  assert.equal(result.details.file, p.details.file);
  assert.equal(await fs.readFile(p.details.file, 'utf8'), bytes);
  assert.equal(result.details.verification, 'human-inspected');
  assert.equal((await fs.stat(p.details.file)).mode & 0o777, 0o600);
});
test('repeat preview preserves the approval of identical immutable bytes', async () => {
  const h = host(), p = await h.preview(); await h.approve(p.details.id);
  assert.equal((await h.preview()).details.id, p.details.id);
  assert.equal((await h.publish(p.details.id)).details.id, p.details.id);
});
test('concurrent identical previews keep one usable revision', async () => {
  const h = host(), [a, b] = await Promise.all([h.preview(), h.preview()]);
  assert.equal(a.details.id, b.details.id); await h.approve(a.details.id); await h.publish(b.details.id);
});
test('an already-cancelled preview performs no IO', async () => {
  const h = host(), c = new AbortController(); c.abort();
  await assert.rejects(h.preview(data(), c.signal), { name: 'AbortError' });
  assert.equal(io.calls.length, 0);
});
test('cancellation during renderer hashing cannot create an artifact directory or file', async () => {
  const h = host(), c = new AbortController();
  io.once('readFile', sourceRead, () => c.abort());
  await assert.rejects(h.preview(data(), c.signal), { name: 'AbortError' });
  assert.deepEqual(mutations(), []);
});
test('switch during renderer hashing cannot write into the new session', async () => {
  const h = host(); io.once('readFile', sourceRead, () => { h.state.owner = 'session-b'; h.events.get('session_switch')(); });
  await assert.rejects(h.preview(), /Session changed/); assert.deepEqual(mutations(), []);
});
test('same-session branch during hashing is rejected by epoch, before writes', async () => {
  const h = host(); io.once('readFile', sourceRead, () => h.events.get('session_branch')());
  await assert.rejects(h.preview(), /Session changed/); assert.deepEqual(mutations(), []);
});
test('cancellation during directory creation cannot begin a file write', async () => {
  const h = host(), c = new AbortController(); io.once('mkdir', () => true, () => c.abort());
  await assert.rejects(h.preview(data(), c.signal), { name: 'AbortError' });
  assert.equal(io.calls.filter(call => call.method === 'writeFile').length, 0);
});
for (const event of ['session_start', 'session_switch', 'session_branch', 'session_tree', 'session_shutdown']) {
  test(`${event} invalidates the inspection`, async () => {
    const h = host(), p = await h.preview(); await h.approve(p.details.id); h.events.get(event)();
    await assert.rejects(h.publish(p.details.id), /not in this session/);
  });
}
test('reset while confirmation is open cannot record approval', async () => {
  const h = host(), p = await h.preview();
  h.state.confirm = async () => { h.events.get('session_tree')(); return true; };
  await assert.rejects(h.approve(p.details.id), /not in this session|Session changed/);
  assert.equal(h.notices.length, 0);
});
test('reset during the final post-confirmation file check cannot report approval', async () => {
  const h = host(), p = await h.preview();
  h.state.confirm = async () => { io.once('readFile', sourceRead, () => h.events.get('session_tree')()); return true; };
  await assert.rejects(h.approve(p.details.id), /not in this session|Session changed/);
  assert.equal(h.notices.length, 0);
});
test('reset during the first approval check cannot even open a stale dialog', async () => {
  const h = host(), p = await h.preview(); let confirms = 0;
  h.state.confirm = async () => { confirms++; return true; };
  io.once('readFile', sourceRead, () => h.events.get('session_tree')());
  await assert.rejects(h.approve(p.details.id), /not in this session|Session changed/);
  assert.equal(confirms, 0);
});
test('cancelled confirmation leaves the preview unapproved', async () => {
  const h = host(), p = await h.preview(); h.state.confirm = async () => false;
  await h.approve(p.details.id); await assert.rejects(h.publish(p.details.id), /inspection/);
});
test('changed data does not inherit prior approval; failed new input keeps the good revision', async () => {
  const h = host(), p = await h.preview(); await h.approve(p.details.id);
  await assert.rejects(h.preview('not json'));
  const other = await h.preview(data(20)); await assert.rejects(h.publish(other.details.id), /inspection/);
  await h.publish(p.details.id);
});
test('modified snapshot fails closed and is never overwritten', async () => {
  const h = host(), p = await h.preview(); await h.approve(p.details.id);
  await fs.writeFile(p.details.file, '{}');
  await assert.rejects(h.publish(p.details.id), /changed/);
  await assert.rejects(h.preview()); assert.equal(await fs.readFile(p.details.file, 'utf8'), '{}');
});
test('rebound factories cannot access another factory preview', async () => {
  const h = host(), p = await h.preview(); await h.approve(p.details.id);
  await assert.rejects(host().publish(p.details.id), /not in this session/);
});
test('publication interrupted by a lifecycle event cannot return a success', async () => {
  const h = host(), p = await h.preview(); await h.approve(p.details.id);
  io.once('readFile', sourceRead, () => h.events.get('session_tree')());
  await assert.rejects(h.publish(p.details.id), /not in this session/);
});
