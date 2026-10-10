#!/usr/bin/env python3
"""Frozen protocol: 15 fresh Bun processes per mode/size, interleaved order.
No CPU competitors; loop wall time is descriptive, not a runtime speedup claim.
"""
import argparse, hashlib, json, math, pathlib, statistics, subprocess
p = argparse.ArgumentParser()
p.add_argument('--bun', required=True)
p.add_argument('--samples', type=int, default=15)
p.add_argument('--output', default='samples.json')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
harness = root / 'validation/issue-11109/scan-harness.ts'
records = []
for size in (5000, 10000, 20000):
    for trial in range(a.samples):
        for mode in (('plain', 'scalar') if trial % 2 == 0 else ('scalar', 'plain')):
            r = subprocess.run([a.bun, str(harness), str(size), mode], cwd=root, text=True, capture_output=True, check=True)
            row = json.loads(r.stdout)
            row.update(trial=trial, mode=mode)
            records.append(row)
summary = []
for size in (5000, 10000, 20000):
    for mode in ('plain', 'scalar'):
        rows = [r for r in records if r['count'] == size and r['mode'] == mode]
        times = sorted(r['elapsedMs'] for r in rows)
        summary.append(dict(count=size, mode=mode, samples=len(rows), medianMs=statistics.median(times),
            p95Ms=times[math.ceil(.95 * len(times))-1], reads=sorted(set(r['reads'] for r in rows), key=lambda n: n or 0)))
files = ['validation/issue-11109/scan-harness.ts', 'validation/issue-11109/run-samples.py',
         'packages/utils/src/incoming-json.ts', 'packages/utils/src/json-lexer.ts',
         'packages/utils/src/json-parse.ts', 'packages/utils/src/async.ts', 'packages/utils/test/incoming-json.test.ts']
output = dict(protocol='fresh-process interleaved, no warmup, loop-only wall time, nearest-rank p95',
    bunVersion=subprocess.check_output([a.bun, '--version'], text=True).strip(),
    sourceSha256={f:hashlib.sha256((root / f).read_bytes()).hexdigest() for f in files}, summary=summary, records=records)
pathlib.Path(a.output).write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(summary, indent=2))
