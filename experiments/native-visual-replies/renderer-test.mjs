// Execute the exact renderer source with a stubbed Tern boundary; no source transpilation.
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from './core.mjs';

const interpreter = process.env.NATIVE_VISUAL_LUA || 'luau';
const files = ['tests/renderer-prelude.luau', 'tern/host.luau', 'tests/renderer-cases.luau'];
const sources = await Promise.all(files.map(file => fs.readFile(new URL(file, import.meta.url), 'utf8')));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-renderer-test-'));
try {
  const script = path.join(directory, 'renderer-tests.luau');
  await fs.writeFile(script, sources.join('\n'), { mode: 0o600 });
  console.log(JSON.stringify({ interpreter, rendererSourceSha256: digest(sources[1]),
    kind: 'exact-source logic test; stubbed Tern API', pixelsVerified: false, paintMeasured: false }));
  const result = spawnSync(interpreter, [script], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error) {
    console.error(`NOT COMPLETE: ${result.error.message}. Set NATIVE_VISUAL_LUA to a Luau or Lua 5.4 executable.`);
    process.exitCode = 2;
  } else process.exitCode = result.status ?? 1;
} finally { await fs.rm(directory, { recursive: true, force: true }); }
