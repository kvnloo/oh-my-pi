import datetime
import json
import os
import pathlib
import subprocess
import shutil
import time

ROOT = pathlib.Path(__file__).resolve().parent
WORKTREE = pathlib.Path(json.loads((ROOT / "checkout.json").read_text())["checkout"])
BUN = shutil.which("bun")
if not BUN:
    raise SystemExit("Bun is required on PATH")
SCRIPTS = {
    "baseline": ROOT / "baseline-tree/packages/coding-agent/bench/format-options.bench.ts",
    "candidate": WORKTREE / "packages/coding-agent/bench/format-options.bench.ts",
}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


environment = {
    "start": now(), "bun": BUN,
    "bunVersion": subprocess.check_output([BUN, "--version"], text=True).strip(),
    "affinity": sorted(os.sched_getaffinity(0)),
    "startLoad": pathlib.Path("/proc/loadavg").read_text().strip(),
    "cpuMax": pathlib.Path("/sys/fs/cgroup/cpu.max").read_text().strip()
    if pathlib.Path("/sys/fs/cgroup/cpu.max").exists() else None,
    "replications": [],
}
for iteration in range(9):
    order = ["baseline", "candidate"] if iteration % 2 == 0 else ["candidate", "baseline"]
    for mode in order:
        start = now()
        start_clock = time.monotonic()
        output = ROOT / f"{mode}-{iteration}.jsonl"
        resource = ROOT / f"{mode}-{iteration}.resource"
        error = ROOT / f"{mode}-{iteration}.stderr"
        with output.open("w") as stdout, error.open("w") as stderr:
            command = [
                BUN, str(SCRIPTS[mode]), str(ROOT / "corpus.json"), str(ROOT / "oracle.json"),
            ]
            child = subprocess.Popen(command, cwd=WORKTREE, stdout=stdout, stderr=stderr)
            _, status, usage = os.wait4(child.pid, 0)
            child.returncode = os.waitstatus_to_exitcode(status)
        resource.write_text(json.dumps({
            "peakRssKiB": usage.ru_maxrss, "userSeconds": usage.ru_utime, "systemSeconds": usage.ru_stime,
        }) + "\n")
        record = {
            "mode": mode, "replication": iteration, "start": start, "end": now(),
            "elapsedSeconds": time.monotonic() - start_clock,
            "exitCode": child.returncode, "resource": resource.read_text().strip(),
        }
        environment["replications"].append(record)
        (ROOT / "replication-environment.json").write_text(json.dumps(environment, indent=2) + "\n")
        print(json.dumps(record), flush=True)
        if child.returncode != 0:
            raise SystemExit(f"Stopped after failed {mode} replication {iteration}; inspect retained stderr")
environment["end"] = now()
environment["endLoad"] = pathlib.Path("/proc/loadavg").read_text().strip()
(ROOT / "replication-environment.json").write_text(json.dumps(environment, indent=2) + "\n")
