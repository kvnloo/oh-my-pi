# Feature: Doctor Command

## User Surface

`omp doctor` — Diagnostic health check command that validates the oh-my-pi installation, checks dependencies, verifies configuration, and reports agent directory status.

## What It Does

- Checks bun runtime version (≥1.3.14 required)
- Verifies omp binary or source accessibility
- Validates git configuration
- Reports agent directory location and ownership
- Checks native addon availability
- Displays configuration discovery paths
- Shows monorepo structure (if in source)

## How to Test

```bash
# Run doctor command
omp doctor

# Expected output includes:
# - Bun version ≥1.3.14
# - OMP version string
# - Git user.email configured
# - Agent directory path (under PI_CODING_AGENT_DIR if set)
# - Config file paths
# - Native addon status
```

## Success Criteria

- Command exits with code 0
- All required dependencies reported as present
- Agent directory path shown and exists
- No critical errors in output

## Evidence Path

`.cursor/skills/verify-omp/evidence/doctor/output.txt`
