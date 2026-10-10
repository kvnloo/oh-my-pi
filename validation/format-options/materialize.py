"""Recreate the frozen public corpus and baseline module in a fresh output directory."""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

RECEIPT = pathlib.Path(__file__).resolve().parent
CHECKOUT = RECEIPT.parent.parent
if len(sys.argv) != 2:
    raise SystemExit("Usage: python3 validation/format-options/materialize.py <empty-output-directory>")
OUT = pathlib.Path(sys.argv[1]).resolve()
if OUT.exists() and any(OUT.iterdir()):
    raise SystemExit("Output directory must be empty; existing files are never overwritten")
OUT.mkdir(parents=True, exist_ok=True)
manifest = json.loads((RECEIPT / "corpus.json").read_text())
synthetic = {
    "empty": "",
    "tiny-yaml": "root:\n  child:\n    leaf: value\n",
    "tiny-space4": "root:\n    child:\n        leaf: value\n",
    "tiny-tabs": "root:\n\tchild:\n\t\tleaf: value\n",
    "stress-4m-short-lines": ("  x: 1\n" * ((4 * 1024 * 1024) // 7 + 1))[:4 * 1024 * 1024],
    "stress-4m-single-line": "x" * (4 * 1024 * 1024),
    "stress-1m-whitespace": " " * (1024 * 1024),
}
unicode_line = "  name: 東京 café 🐉\n"
synthetic["stress-1m-unicode"] = (unicode_line * ((1024 * 1024) // len(unicode_line) + 1))[:1024 * 1024]
corpus = OUT / "corpus"
corpus.mkdir()
for name, fixture in manifest["corpus"].items():
    source = fixture["source"]
    data = subprocess.check_output(["git", "show", f'{manifest["base"]}:{source}'], cwd=CHECKOUT) \
        if source else synthetic[name].encode()
    if len(data) != fixture["bytes"] or hashlib.sha256(data).hexdigest() != fixture["sha256"]:
        raise SystemExit(f"Frozen fixture mismatch: {name}")
    (corpus / fixture["file"]).write_bytes(data)
for name in ["corpus.json", "oracle.json", "summarize.py", "run-replications.py"]:
    shutil.copyfile(RECEIPT / name, OUT / name)
baseline = OUT / "baseline-tree"
helper = baseline / "packages/coding-agent/src/lsp/format-options.ts"
helper.parent.mkdir(parents=True)
helper.write_bytes(subprocess.check_output([
    "git", "show", f'{manifest["base"]}:packages/coding-agent/src/lsp/format-options.ts'
], cwd=CHECKOUT))
bench = baseline / "packages/coding-agent/bench/format-options.bench.ts"
bench.parent.mkdir(parents=True)
shutil.copyfile(CHECKOUT / "packages/coding-agent/bench/format-options.bench.ts", bench)
if not (CHECKOUT / "node_modules").is_dir():
    raise SystemExit("Install the checkout's dependencies before running the benchmark")
(baseline / "node_modules").symlink_to(CHECKOUT / "node_modules", target_is_directory=True)
(OUT / "checkout.json").write_text(json.dumps({"checkout": str(CHECKOUT)}, indent=2) + "\n")
print(json.dumps({"output": str(OUT), "fixtures": len(manifest["corpus"]), "base": manifest["base"]}))
