import * as fs from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { digest, prepare, visibleChildren } from './core.mjs';
const rendererHash = digest(JSON.stringify(await Promise.all(['plugin.toml', 'host.luau', 'window.luau', 'visual.css'].map(name => fs.readFile(new URL(`./tern/${name}`, import.meta.url), 'utf8')))));
const file = (id, code, churn) => ({ id, label: `${id}.ts`, code, churn });
const sample = { version: 1, title: 'Synthetic repository — code/churn units (not real measurements)', root: { id: 'root', label: 'sample-repo', children: [
  { id: 'apps', label: 'apps/', children: [file('web', 1500, 80), file('server', 2200, 30)] },
  { id: 'packages', label: 'packages/', children: [file('tui', 1000, 70), file('wire', 400, 20)] },
  { id: 'docs', label: 'docs/', children: [file('guide', 200, 10)] },
] } };
if (process.argv.includes('--fixture')) {
  await fs.writeFile(new URL('./tern/demo.visual.json', import.meta.url), JSON.stringify(prepare(JSON.stringify(sample), rendererHash), null, 2) + '\n');
} else {
  const results = [];
  for (const n of [1000, 5000, 50000]) {
    const json = JSON.stringify({ ...sample, root: { id: 'root', label: 'synthetic', children: Array.from({ length: n }, (_, i) => file(`f${i}`, i % 200 + 1, i % 17)) } });
    const runs = [];
    for (let run = 0; run < 6; run++) {
      const start = performance.now(); const artifact = prepare(json, rendererHash); const prepared = performance.now();
      const visible = visibleChildren(artifact.document.root); const end = performance.now();
      if (run > 0) runs.push({ prepareMs: prepared - start, projectionMs: end - prepared, visible: visible.length });
    }
    results.push({ files: n, inputBytes: Buffer.byteLength(json), runs });
  }
  console.log(JSON.stringify({ kind: 'JS contract microbenchmark ONLY', node: process.version, rendererHash,
    luauExecuted: false, ompExecuted: false, pixelsVerified: false, endToEndMeasured: false, results }, null, 2));
}
