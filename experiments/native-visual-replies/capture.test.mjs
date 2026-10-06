import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capture } from './capture.mjs';

let root;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-capture-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const success = () => ({ status: 0, signal: null, stdout: 'synthetic control response', stderr: '' });
const options = () => ({ control: '/tmp/test-control.sock', output: path.join(root, 'run') });

test('pins the explicit control and retains all responses without granting authority', async () => {
  const calls = [], config = options();
  const report = await capture(config, (args, opts) => { calls.push({ args, opts }); return success(); });
  assert.equal(calls.length, 20); assert.equal(report.status, 'control-checks-passed');
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 3), ['ctl', '--control', config.control]);
    assert.equal(call.opts.shell, false); assert.equal(call.opts.timeout, 15000);
    assert.equal(call.opts.maxBuffer, 1024 * 1024); assert.equal(call.opts.killSignal, 'SIGKILL');
    assert.ok(!call.args.includes('fixtures')); assert.ok(!call.args.includes('install'));
  }
  const manifest = JSON.parse(await fs.readFile(path.join(config.output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.publicationAuthorized, false); assert.equal(manifest.pixelsVerified, false);
  assert.equal(manifest.installedRendererAttested, false); assert.equal(manifest.screenshotFilesCollected, false);
  assert.equal(manifest.paintLatencyMeasured, false); assert.equal(manifest.localSource.artifactId.length, 64);
  assert.equal((await fs.stat(config.output)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(config.output, 'manifest.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(config.output)).length, 41);
});
test('first failed expectation stops later input and preserves diagnostics', async () => {
  let calls = 0; const config = options();
  const report = await capture(config, () => { calls++; return calls === 4 ? { ...success(), status: 1, stderr: 'fixture not focused' } : success(); });
  assert.equal(calls, 4); assert.equal(report.status, 'failed'); assert.match(report.failure, /expect-preview/);
  assert.equal(await fs.readFile(path.join(config.output, 'expect-preview.stderr.txt'), 'utf8'), 'fixture not focused');
});
test('timeout is failure, never an empty successful screenshot', async () => {
  const report = await capture(options(), () => ({ status: null, signal: 'SIGKILL', error: new Error('ETIMEDOUT') }));
  assert.equal(report.status, 'failed'); assert.match(report.failure, /ETIMEDOUT/); assert.equal(report.steps.length, 1);
});
test('missing Tern produces a recorded failure', async () => {
  const report = await capture(options(), () => ({ status: null, error: new Error('ENOENT tern') }));
  assert.equal(report.status, 'failed'); assert.match(report.failure, /ENOENT/);
});
test('unexpected executor failure also records a failed run', async () => {
  const config = options(), report = await capture(config, () => { throw new Error('transport failed'); });
  assert.equal(report.status, 'failed'); assert.match(report.failure, /transport/);
  assert.equal(JSON.parse(await fs.readFile(path.join(config.output, 'manifest.json'), 'utf8')).status, 'failed');
});
test('output budget truncates the log and fails the run', async () => {
  const config = options(), report = await capture(config, () => ({ ...success(), stdout: 'x'.repeat(1024 * 1024 + 1) }));
  assert.equal(report.status, 'failed'); assert.match(report.failure, /output budget/);
  assert.equal((await fs.stat(path.join(config.output, 'state-before.stdout.txt'))).size, 1024 * 1024);
});
test('refuses implicit control, relative output and invalid timeout before execution', async () => {
  let calls = 0;
  for (const override of [{ control: undefined }, { control: 'relative.sock' }, { control: '/tmp/a\nnext' }, { output: '.' }, { timeoutMs: 0 }, { timeoutMs: 60001 }]) {
    await assert.rejects(capture({ ...options(), ...override }, () => { calls++; return success(); }));
  }
  assert.equal(calls, 0);
});
test('refuses output inside the watched plugin directory', async () => {
  await assert.rejects(capture({ ...options(), output: fileURLToPath(new URL('./tern/evidence', import.meta.url)) }, success), /watched/);
});
test('refuses existing output instead of overwriting previous evidence', async () => {
  const config = options(); await capture(config, success); let calls = 0;
  await assert.rejects(capture(config, () => { calls++; return success(); }), { code: 'EEXIST' });
  assert.equal(calls, 0);
});
test('quoted text reaches the scenario parser intact, shot names are unique', async () => {
  const first = await capture(options(), success);
  const second = await capture({ ...options(), output: path.join(root, 'second') }, success);
  assert.deepEqual(first.steps.find(step => step.name === 'select-churn').args.slice(3), ['type', '"2"']);
  assert.deepEqual(first.steps.find(step => step.name === 'expect-churn').args.slice(3), ['plugins', 'expect', '"Mode: churn"']);
  assert.notEqual(first.steps.find(step => step.name === 'shot-code').args.at(-1), second.steps.find(step => step.name === 'shot-code').args.at(-1));
});
