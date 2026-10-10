import json
import statistics
from pathlib import Path

root = Path(__file__).parent
inputs = {}
for path in sorted(root.glob("run-*-*.json")):
    _, number, arm = path.stem.split("-")
    data = json.loads(path.read_text())
    by_workload = {}
    for record in data["records"]:
        by_workload.setdefault(record["workload"], []).append(record["nsPerOp"])
    inputs[int(number)] = {"arm": arm, "data": data, "by_workload": by_workload}

if len(inputs) != 8:
    raise RuntimeError(f"Expected eight complete timing arms, found {len(inputs)}")

pairing = [(1, 2), (4, 3), (5, 6), (8, 7)]
summary = []
for workload in inputs[1]["by_workload"]:
    baseline = [sample for item in inputs.values() if item["arm"] == "baseline"
                for sample in item["by_workload"][workload]]
    candidate = [sample for item in inputs.values() if item["arm"] == "candidate"
                 for sample in item["by_workload"][workload]]
    paired_ratios = [statistics.median(inputs[c]["by_workload"][workload]) /
                     statistics.median(inputs[b]["by_workload"][workload]) for b, c in pairing]
    row = {
        "workload": workload,
        "samplesPerArm": len(baseline),
        "baselineMedianUs": statistics.median(baseline) / 1000,
        "baselineRangeUs": [min(baseline) / 1000, max(baseline) / 1000],
        "candidateMedianUs": statistics.median(candidate) / 1000,
        "candidateRangeUs": [min(candidate) / 1000, max(candidate) / 1000],
        "absoluteMedianDeltaUs": (statistics.median(candidate) - statistics.median(baseline)) / 1000,
        "pairedRatios": paired_ratios,
        "medianPairedRatio": statistics.median(paired_ratios),
    }
    summary.append(row)

output = {
    "aggregation": json.loads((root / "run-plan.json").read_text())["aggregation"],
    "pairs": pairing,
    "checksumByProcess": {str(number): value["data"]["checksum"] for number, value in inputs.items()},
    "results": summary,
}
(root / "summary.json").write_text(json.dumps(output, indent=2) + "\n")
print("workload | baseline median us [range] | candidate median us [range] | delta us | paired median ratio [all 4]")
for row in summary:
    fmt_range = lambda values: f"{values[0]:.3f}..{values[1]:.3f}"
    ratios = ", ".join(f"{value:.3f}" for value in row["pairedRatios"])
    print(f'{row["workload"]} | {row["baselineMedianUs"]:.3f} [{fmt_range(row["baselineRangeUs"])}] | '
          f'{row["candidateMedianUs"]:.3f} [{fmt_range(row["candidateRangeUs"])}] | '
          f'{row["absoluteMedianDeltaUs"]:+.3f} | {row["medianPairedRatio"]:.3f} [{ratios}]')
