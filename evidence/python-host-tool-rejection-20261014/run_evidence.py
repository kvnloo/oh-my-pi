"""Replay OMP155 against hash-checked source; no network or installation needed."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = "f5145fd0271906cdf3bca6a218912fa1d8db3500"
CLIENT_SHA256 = "611122886c8bc85381709a85c95bbbe15d8158b62e85fe8192b4b2f29080f68a"
TEST_SHA256 = "04e792dbede6a343a5c063370c498957ec0039c47a5b17593605ad871bf5facb"


def main() -> None:
    if not __debug__:
        raise SystemExit(
            "Do not use -O: this evidence runner requires assertion guards"
        )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate", type=Path, required=True, help="SDK directory")
    parser.add_argument("--baseline", type=Path, help="Optional exact SDK snapshot")
    parser.add_argument("--output", type=Path, required=True, help="New log directory")
    parser.add_argument(
        "--pytest", action="store_true", help="Use already installed pytest"
    )
    args = parser.parse_args()
    candidate = args.candidate.resolve()
    baseline_source = args.baseline.resolve() if args.baseline else None
    manifest = json.loads((HERE / "source-manifest.json").read_text())
    assert manifest["upstream"] == BASE
    for path, digest in (
        ("src/omp_rpc/client.py", CLIENT_SHA256),
        ("tests/test_host_tool_registration.py", TEST_SHA256),
    ):
        assert hashlib.sha256((candidate / path).read_bytes()).hexdigest() == digest, (
            path
        )
    args.output.mkdir(parents=True, exist_ok=False)

    with tempfile.TemporaryDirectory(prefix="omp155-baseline-") as temporary:
        baseline = Path(temporary)
        for row in manifest["files"]:
            path = row["path"]
            if baseline_source:
                content = (baseline_source / path).read_bytes()
            else:
                content = subprocess.check_output(
                    ["git", "show", f"{BASE}:sdk/python/omp-rpc/{path}"], cwd=candidate
                )
            digest = hashlib.sha1(
                f"blob {len(content)}\0".encode() + content
            ).hexdigest()
            assert len(content) == row["size"] and digest == row["sha"], path
            if path != "src/omp_rpc/client.py":
                assert (candidate / path).read_bytes() == content, path
            target = baseline / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        shutil.copyfile(
            candidate / "tests/test_host_tool_registration.py",
            baseline / "tests/test_host_tool_registration.py",
        )

        def run(label: str, cwd: Path, command: list[str], expected: int = 0) -> str:
            environment = dict(
                os.environ,
                PYTHONPATH=f"{cwd / 'src'}{os.pathsep}{cwd}",
                PYTHONDONTWRITEBYTECODE="1",
            )
            result = subprocess.run(
                [sys.executable, "-B", *command],
                cwd=cwd,
                check=False,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                timeout=90,
            )
            (args.output / f"{label}.log").write_text(result.stdout)
            print(f"{label}: exit {result.returncode}", flush=True)
            assert result.returncode == expected, (label, result.stdout)
            return result.stdout

        test = ["-m", "unittest", "-v", "tests.test_host_tool_registration"]
        red = run("baseline-regression", baseline, test, 1)
        assert "Ran 15 tests" in red and "FAILED (failures=7, errors=1)" in red
        green = run("candidate-regression", candidate, test)
        assert "Ran 15 tests" in green and "\nOK\n" in green
        adjacent = [
            "-m",
            "unittest",
            "-v",
            "tests.test_client",
            "tests.test_host_uris",
            "tests.test_protocol",
        ]
        for arm, cwd in (("baseline", baseline), ("candidate", candidate)):
            result = run(f"{arm}-adjacent", cwd, adjacent)
            assert "Ran 104 tests" in result and "\nOK\n" in result
        for script in (
            "reproduce_interrupted_registration.py",
            "reproduce_reentrant_registration.py",
            "review_outcome_model.py",
        ):
            run(script.removesuffix(".py"), candidate, [str(HERE / "review" / script)])
        if args.pytest:
            original_tests = [
                row["path"]
                for row in manifest["files"]
                if row["path"].startswith("tests/test_")
            ]
            red_sdk = run(
                "baseline-sdk-pytest", baseline, ["-m", "pytest", "-q", *original_tests]
            )
            green_sdk = run(
                "candidate-sdk-pytest", candidate, ["-m", "pytest", "-q", "tests"]
            )
            assert "107 passed" in red_sdk and "122 passed" in green_sdk
    print(
        "PASS: source guards, expected RED, GREEN, adjacent controls and independent probes"
    )


if __name__ == "__main__":
    main()
