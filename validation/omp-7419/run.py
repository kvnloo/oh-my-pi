#!/usr/bin/env python3
"""Compile exact cloud/primitives source with a measurement-only wrapper.

The unused minimizer context/config/output facade in harness.rs is deliberately
minimal. This exercises the real cloud module, not full shell/dispatch wiring.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("mode", choices=["verify", "regression", "bench", "tests", "lint", "differential"])
parser.add_argument("--ref", help="Read source from this git revision instead of the working tree")
parser.add_argument("--offline", action="store_true", help="Use cached dependencies only")
args = parser.parse_args()
work = Path(tempfile.mkdtemp(prefix="omp-7419-"))
(work / "src").mkdir()
for name in ["Cargo.toml", "Cargo.lock"]:
    shutil.copyfile(HERE / name, work / name)
shutil.copyfile(HERE / ("differential.rs" if args.mode == "differential" else "timed-harness.rs" if args.mode == "bench" else "harness.rs"), work / "src/main.rs")

def read_source(path, ref=None):
    ref = ref or args.ref
    if ref:
        return subprocess.check_output(["git", "show", f"{ref}:{path}"], cwd=ROOT, text=True)
    return (ROOT / path).read_text()

cloud = read_source("crates/pi-shell/src/minimizer/filters/cloud.rs")
primitives = read_source("crates/pi-shell/src/minimizer/primitives.rs")
(work / ("src/candidate_cloud.rs" if args.mode == "differential" else "src/selected_cloud.rs")).write_text(cloud.replace("//! Cloud and data command output filters.", "// Cloud and data command output filters.", 1) + "\npub fn compact_generic_for_measurement(root: &Value) -> Option<String> { compact_aws_generic(root) }\n")
# Keep measurement wrappers before test modules so strict Clippy also checks
# the exact included production tests without a generated-code lint failure.
for cloud_name in (["baseline_cloud.rs", "candidate_cloud.rs"] if args.mode == "differential" else ["selected_cloud.rs"]):
    cloud_path = work / "src" / cloud_name
    if cloud_path.exists():
        text = cloud_path.read_text()
        wrapper = "pub fn compact_generic_for_measurement(root: &Value) -> Option<String> { compact_aws_generic(root) }"
        cloud_path.write_text(wrapper + "\n" + text.replace("\n" + wrapper + "\n", "\n"))
(work / "src/primitives.rs").write_text(primitives.replace("//! Reusable text transforms shared by minimizer filters.", "// Reusable text transforms shared by minimizer filters.", 1))
if args.mode == "differential":
    baseline = read_source("crates/pi-shell/src/minimizer/filters/cloud.rs", "46ad32961a96aef21cd35fe615374f4b3675ca58")
    (work / "src/baseline_cloud.rs").write_text(baseline.replace("//! Cloud and data command output filters.", "// Cloud and data command output filters.", 1) + "\npub fn compact_generic_for_measurement(root: &Value) -> Option<String> { compact_aws_generic(root) }\n")
os.environ.setdefault("CARGO_BUILD_JOBS", "2")
base = ["cargo"]
manifest = ["--manifest-path", str(work / "Cargo.toml"), "--locked"]
if args.offline:
    manifest.append("--offline")
if args.mode == "tests":
    command = base + ["nextest", "run"] + manifest
elif args.mode == "lint":
    command = base + ["clippy"] + manifest + ["--all-targets", "--", "-D", "warnings"]
else:
    command = base + ["build", "--release"] + manifest
subprocess.run(command, check=True, cwd=work)
if args.mode not in ["tests", "lint"]:
    target = Path(os.environ.get("CARGO_TARGET_DIR", str(work / "target")))
    binary = [str(target / "release/omp-perf-validation")]
    if args.mode != "differential":
        binary += [args.mode, str(HERE / "frozen-output.json")]
    subprocess.run(binary, check=True)
print(f"Validation workspace: {work}")
