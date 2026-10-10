#!/usr/bin/env python3
"""Bounded mutation proof: restart array scans at the opening delimiter.
Only temporary copies are changed. 128/256/512 elements keep work bounded.
"""
import argparse, hashlib, json, pathlib, shutil, subprocess, tempfile
p = argparse.ArgumentParser()
p.add_argument('--bun', required=True)
p.add_argument('--output', default='mutant.json')
a = p.parse_args()
root = pathlib.Path(__file__).resolve().parents[2]
old = '''\tconst known = index.elements[segment];
\tlex.pos = known?.offset ?? index.frontier;
\treturn selectIndex(lex, segment, path, at + 1, ended, depth, known ? segment : index.elements.length, index);'''
new = '''\tlex.pos++;
\treturn selectIndex(lex, segment, path, at + 1, ended, depth, 0, index);'''
source = (root / 'packages/utils/src/incoming-json.ts').read_text()
assert source.count(old) == 1
rows = []
with tempfile.TemporaryDirectory(prefix='omp-rescan-mutant-') as directory:
    temp = pathlib.Path(directory)
    target = temp / 'packages/utils/src'
    target.mkdir(parents=True)
    for name in ('incoming-json.ts', 'async.ts', 'json-lexer.ts', 'json-parse.ts'):
        shutil.copyfile(root / 'packages/utils/src' / name, target / name)
    mutant = source.replace(old, new)
    (target / 'incoming-json.ts').write_text(mutant)
    harness = temp / 'validation/issue-11109/scan-harness.ts'
    harness.parent.mkdir(parents=True)
    shutil.copyfile(root / 'validation/issue-11109/scan-harness.ts', harness)
    for size in (128, 256, 512):
        r = subprocess.run([a.bun, str(harness), str(size), 'scalar'], text=True, capture_output=True, cwd=temp)
        row = json.loads(r.stdout)
        assert r.returncode == 1 and not row['readBound'] and row['sumCorrect'] and row['exhausted'] and row['restored'], row
        rows.append(row)
output = dict(description='array frontier bypass: restart each selection at first element; expected read-bound failure with semantics preserved',
    sourceSha256=hashlib.sha256(source.encode()).hexdigest(), mutantSha256=hashlib.sha256(mutant.encode()).hexdigest(), rows=rows)
pathlib.Path(a.output).write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(rows, indent=2))
