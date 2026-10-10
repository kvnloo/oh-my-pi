import json
import math
import pathlib
import random
import statistics
import sys

ROOT = pathlib.Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "corpus.json").read_text())


def read_rows(path):
    return {
        (row["mode"], row["id"]): row
        for row in (json.loads(line) for line in pathlib.Path(path).read_text().splitlines())
        if "mode" in row
    }


def flatness(rows):
    tiny = rows[("warm", "complete-space/tiny-yaml")]["medianMs"]
    limit = 5 * tiny + 0.05
    checks = []
    for name in ["stress-4m-short-lines", "stress-4m-single-line"]:
        actual = rows[("warm", f"complete-space/{name}")]["medianMs"]
        checks.append({"case": name, "medianMs": actual, "limitMs": limit, "pass": actual <= limit})
    return checks


if len(sys.argv) > 1:
    checks = flatness(read_rows(sys.argv[1]))
    print(json.dumps({"flatness": checks, "pass": all(row["pass"] for row in checks)}, indent=2))
    sys.exit(0 if all(row["pass"] for row in checks) else 1)

BASE = [read_rows(ROOT / f"baseline-{i}.jsonl") for i in range(9)]
CANDIDATE = [read_rows(ROOT / f"candidate-{i}.jsonl") for i in range(9)]


def process_percentile(values, fraction):
    values = sorted(values)
    return values[min(len(values) - 1, math.ceil(len(values) * fraction) - 1)]


summary = []
for mode, scenarios in [("warm", MANIFEST["warmCases"]), ("cold-metadata", MANIFEST["coldCases"])]:
    for scenario in scenarios:
        key = (mode, scenario["id"])
        base = [rows[key]["medianMs"] for rows in BASE]
        candidate = [rows[key]["medianMs"] for rows in CANDIDATE]
        before, after = statistics.median(base), statistics.median(candidate)
        protected = mode == "cold-metadata" or scenario["config"] not in {
            "complete-space", "complete-tab", "complete-inferred"
        } or scenario["content"] in {"empty", "tiny-yaml"}
        tolerance = 0.05 if mode == "cold-metadata" else 0.02
        gate = after <= 1.1 * before or after - before < tolerance
        summary.append({
            "mode": mode, "id": scenario["id"],
            "bytes": MANIFEST["corpus"][scenario["content"]]["bytes"],
            "baselineMedianMs": before, "candidateMedianMs": after,
            "baselineProcessP95Ms": process_percentile(base, 0.95),
            "candidateProcessP95Ms": process_percentile(candidate, 0.95),
            "speedup": before / after, "deltaMs": after - before,
            "protected": protected, "protectedPass": gate if protected else None,
            "baselineProcessMediansMs": base, "candidateProcessMediansMs": candidate,
        })

primary = [case["id"] for case in MANIFEST["warmCases"] if case.get("primary")]
pair_log_ratios = [
    statistics.mean(math.log(BASE[i][("warm", key)]["medianMs"] / CANDIDATE[i][("warm", key)]["medianMs"])
                    for key in primary)
    for i in range(9)
]
geomean = math.exp(statistics.mean(pair_log_ratios))
rng = random.Random(2329)
bootstraps = sorted(math.exp(statistics.mean(rng.choices(pair_log_ratios, k=9))) for _ in range(10000))
aggregate_rows = {(row["mode"], row["id"]): {"medianMs": row["candidateMedianMs"]} for row in summary}
scaling = flatness(aggregate_rows)
protected_pass = all(row["protectedPass"] is not False for row in summary)
result = {
    "primaryCases": primary, "primaryGeometricMeanSpeedup": geomean,
    "primaryTimeReductionFraction": 1 - 1 / geomean,
    "primaryPairedBootstrap95Speedup": [bootstraps[249], bootstraps[9749]],
    "primaryPass": geomean >= 4 / 3,
    "candidateFlatness": scaling,
    "protectedPass": protected_pass,
    "allPass": geomean >= 4 / 3 and protected_pass and all(row["pass"] for row in scaling),
    "rows": summary,
    "notes": [
        "Primary statistic is geometric mean of within-pair speedup across five fixed public-source inputs.",
        "Warm batchP95 in raw rows is over nine batched sample averages within a process.",
        "ProcessP95 here is over nine independent process medians; neither measures user-operation p95.",
        "Cold metadata uses unique directories and excludes fixture writes; OS page caches are uncontrolled.",
        "No measured formatting-server or full-agent end-to-end speedup is claimed.",
        "Peak RSS is descriptive for processes holding the full corpus, not transient allocation evidence.",
    ],
}
(ROOT / "results.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps({key: value for key, value in result.items() if key != "rows"}, indent=2))
for row in summary:
    print(f'{row["mode"]:13} {row["id"]:43} {row["baselineMedianMs"]:.6f} -> '
          f'{row["candidateMedianMs"]:.6f} ms {row["speedup"]:.3f}x '
          f'delta={row["deltaMs"]:+.6f} protected={row["protectedPass"]}')
sys.exit(0 if result["allPass"] else 1)
