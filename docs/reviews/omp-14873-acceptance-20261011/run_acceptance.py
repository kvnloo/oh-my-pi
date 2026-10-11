"""Replay fixture-owned acceptance with existing dependencies and local Git objects.

No checkout, fetch, install, or external request is performed. The caller provides
isolated source archives. Only the two test files beside this runner are added.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--archive", type=Path, required=True)
parser.add_argument("--git-source", type=Path, required=True)
parser.add_argument("--commit", required=True)
parser.add_argument("--rpc-src", type=Path, required=True)
parser.add_argument("--dependency-path", type=Path, action="append", default=[])
parser.add_argument("--tests", nargs="+", required=True)
args = parser.parse_args()
allowed = {
    "tests/test_queue_dispatch.py",
    "tests/test_queue_shutdown.py",
    "tests/test_dispatch_recovery.py",
    "tests/test_independent_claim_recovery.py",
    "tests/test_critic_acceptance.py",
}
if any(item.split("::", 1)[0] not in allowed for item in args.tests):
    parser.error("Only the five fixture-owned queue test files in this packet may be selected")
archive = args.archive.resolve()
project = archive / "python/robomp"
rpc = args.rpc_src.resolve()
if (archive / ".git").exists():
    parser.error("Use an isolated source archive, not a Git checkout")
os.environ["GIT_NO_LAZY_FETCH"] = "1"
os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
sys.dont_write_bytecode = True


def git(*arguments: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(args.git_source), *arguments])


commit = git("rev-parse", f"{args.commit}^{{commit}}").decode().strip()
files = git("ls-tree", "-r", "--name-only", commit, "python/robomp").decode().splitlines()
assert files, "No robomp files found in the requested local commit"
for name in files:
    assert (archive / name).read_bytes() == git("show", f"{commit}:{name}"), name
rpc_files = git("ls-tree", "-r", "--name-only", commit, "sdk/python/omp-rpc/src").decode().splitlines()
for name in rpc_files:
    relative = Path(name).relative_to("sdk/python/omp-rpc/src")
    assert (rpc / relative).read_bytes() == git("show", f"{commit}:{name}"), name
for filename in ["test_independent_claim_recovery.py", "test_critic_acceptance.py"]:
    supplied = Path(__file__).resolve().with_name(filename).read_bytes()
    target = project / "tests" / filename
    if target.exists():
        assert target.read_bytes() == supplied, f"Existing independent test differs: {filename}"
    else:
        target.write_bytes(supplied)
print(f"SOURCE {commit}: {len(files)} tracked robomp files and {len(rpc_files)} RPC source files match local Git blobs", flush=True)
sys.path[:0] = [str(project), str(rpc), *[str(p.resolve()) for p in args.dependency_path]]
os.chdir(project)
network_attempts: list[str] = []


def audit(event: str, _args: object) -> None:
    if event in {"socket.connect", "socket.getaddrinfo"}:
        network_attempts.append(event)
        raise RuntimeError("External socket operation forbidden by local-only acceptance runner")


sys.addaudithook(audit)
spec = importlib.util.spec_from_file_location("robomp", project / "src/__init__.py", submodule_search_locations=[str(project / "src")])
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
sys.modules["robomp"] = module
spec.loader.exec_module(module)
import pytest

print(f"VERSIONS Python {sys.version.split()[0]}, pytest {pytest.__version__}, pytest-asyncio {importlib.metadata.version('pytest-asyncio')}", flush=True)
with tempfile.TemporaryDirectory(prefix="omp-acceptance-") as temporary:
    code = pytest.main(["-p", "pytest_asyncio.plugin", "-q", "-p", "no:cacheprovider", "--basetemp", temporary, *args.tests])
contaminated = []
for name, imported in tuple(sys.modules.items()):
    filename = getattr(imported, "__file__", None)
    if not filename:
        continue
    if name == "robomp" or name.startswith("robomp."):
        expected = project / "src"
    elif name == "tests" or name.startswith("tests."):
        expected = project / "tests"
    elif name == "omp_rpc" or name.startswith("omp_rpc."):
        expected = rpc
    else:
        continue
    if not Path(filename).resolve().is_relative_to(expected.resolve()):
        contaminated.append(name)
print(f"ISOLATION {'PASS' if not contaminated else contaminated}; outbound socket attempts: {len(network_attempts)}", flush=True)
raise SystemExit(code if not contaminated and not network_attempts else 97)
