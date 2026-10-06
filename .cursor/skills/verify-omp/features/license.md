# Feature: License Output

## Sub-features

- `omp --license` — Print the OMP MIT license and aggregated third-party notices

## How to get to it

```bash
omp --license
# source mode:
bun packages/coding-agent/src/cli.ts --license
```

## Driving it with the harness

The verification harness (`bin/omp-verify`) tests `--license`:

1. Runs `omp --license` and captures output to `evidence/license/output.txt`
2. Requires a zero exit code
3. Requires the output to contain `MIT License` and `OMP License`
4. Fails hard (exit 1) if the command fails or the markers are missing

## Gotchas

- Output is large (tens of thousands of lines of third-party notices); evidence may truncate with a pointer to a full log
- In source mode the harness uses `bun packages/coding-agent/src/cli.ts` (same as other features)
- Handled in `packages/coding-agent/src/cli.ts` via `formatLicenseOutput()` from `./cli/license`
