// Standalone developer runner; never loaded by OMP or the Tern plugin.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, prepare } from './core.mjs';

const plugin = fileURLToPath(new URL('./tern/', import.meta.url));
const rendererFiles = ['plugin.toml', 'host.luau', 'window.luau', 'visual.css'];
const MAX_OUTPUT = 1024 * 1024;
const SELECTOR = "[data-surface='plugin.native-visual.reply']";
async function snapshot() {
  const sources = await Promise.all(rendererFiles.map(file => fs.readFile(path.join(plugin, file), 'utf8')));
  const rendererHash = digest(JSON.stringify(sources));
  const text = await fs.readFile(path.join(plugin, 'demo.visual.json'), 'utf8');
  const fixture = JSON.parse(text), expected = prepare(JSON.stringify(fixture.document), rendererHash);
  if (fixture.schema !== expected.schema || fixture.id !== expected.id || fixture.rendererHash !== rendererHash) {
    throw new Error('Demo fixture does not match the local renderer. Regenerate with study.mjs --fixture.');
  }
  return { rendererHash, artifactId: expected.id, fixtureHash: digest(text),
    sourceSha256: Object.fromEntries(rendererFiles.map((file, i) => [file, digest(sources[i])])) };
}
function steps(id, prefix) {
  // Command shapes are from Tern's debugging guide; no fixtures installation or unknown open API.
  return [
    ['state-before', ['state']], ['styles', ['css']],
    ['open-demo', ['plugins', 'run', 'plugin.native-visual.demo']],
    ['expect-preview', ['plugins', 'expect', JSON.stringify(`Preview ${id.slice(0, 12)}`)]],
    ['expect-code', ['plugins', 'expect', '"Mode: code"']],
    ['tree-code', ['tree', SELECTOR]], ['shot-code', ['shot', `${prefix}-code`]],
    ['select-churn', ['type', '"2"']], ['expect-churn', ['plugins', 'expect', '"Mode: churn"']],
    ['tree-churn', ['tree', SELECTOR]], ['shot-churn', ['shot', `${prefix}-churn`]],
    ['drill', ['key', 'Enter']], ['expect-child', ['plugins', 'expect', '"apps/"']],
    ['back', ['key', 'Left']], ['expect-root', ['plugins', 'expect', '"sample-repo"']],
    ['select-code', ['type', '"1"']], ['expect-code-again', ['plugins', 'expect', '"Mode: code"']],
    ['tree-final', ['tree', SELECTOR]], ['shot-final', ['shot', `${prefix}-final`]], ['state-after', ['state']],
  ];
}
const runTern = (args, options) => spawnSync('tern', args, options);

/** Control evidence only: an exit-zero expectation is not pixel verification or publish authority. */
export async function capture({ control, output, timeoutMs = 15000 }, execute = runTern) {
  if (typeof control !== 'string' || !path.isAbsolute(control) || /[\u0000-\u001f]/u.test(control)) throw new Error('An explicit absolute control socket is required');
  if (typeof output !== 'string' || !path.isAbsolute(output)) throw new Error('An absolute fresh output directory is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid timeout');
  const parent = await fs.realpath(path.dirname(output));
  const directory = path.join(parent, path.basename(output));
  const pluginRoot = await fs.realpath(plugin);
  if (directory === pluginRoot || directory.startsWith(pluginRoot + path.sep)) throw new Error('Evidence must stay outside the watched plugin directory');
  const before = await snapshot();
  await fs.mkdir(directory, { mode: 0o700 }); // EEXIST is intentional: never overwrite an earlier run.
  const report = { schema: 'native-visual-control-evidence/v1', status: 'running', control,
    startedAt: new Date().toISOString(), localSource: before, steps: [],
    installedRendererAttested: false, pixelsVerified: false, publicationAuthorized: false,
    screenshotFilesCollected: false, paintLatencyMeasured: false,
    limitations: 'Local hashes do not attest installed code. Shot responses are retained; PNG locations are not guessed. Review Tern screenshots, theme, viewport and logs separately. No approval receipt is created.' };
  try {
    const prefix = `native-visual-${randomUUID()}`;
    for (const [name, command] of steps(before.artifactId, prefix)) {
      const args = ['ctl', '--control', control, ...command];
      const start = performance.now();
      const result = await execute(args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: MAX_OUTPUT, killSignal: 'SIGKILL', shell: false });
      const entry = { name, args, exitCode: result.status ?? null, signal: result.signal ?? null,
        controlRoundTripMs: performance.now() - start, error: result.error?.message ?? null };
      report.steps.push(entry);
      for (const stream of ['stdout', 'stderr']) {
        const bytes = Buffer.from(result[stream] ?? '');
        await fs.writeFile(path.join(directory, `${name}.${stream}.txt`), bytes.subarray(0, MAX_OUTPUT), { flag: 'wx', mode: 0o600 });
        if (bytes.length > MAX_OUTPUT) throw new Error(`${name} exceeded the output budget`);
      }
      if (result.error || result.signal || result.status !== 0) throw new Error(`${name} failed: ${entry.error ?? entry.signal ?? entry.exitCode}`);
    }
    const after = await snapshot();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Local renderer or fixture changed during capture');
    report.status = 'control-checks-passed';
  } catch (error) {
    report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 4) throw new Error('Unexpected arguments');
    const output = process.argv[3] ?? path.join(os.tmpdir(), `native-visual-evidence-${randomUUID()}`);
    const report = await capture({ control: process.argv[2], output });
    console.log(`${report.status}: ${path.join(output, 'manifest.json')}`);
    if (report.status !== 'control-checks-passed') { console.error(report.failure); process.exitCode = 1; }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: node capture.mjs /absolute/control.sock [/absolute/fresh-evidence-directory]');
    process.exitCode = 2;
  }
}
