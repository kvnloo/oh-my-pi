# Verification Evidence

This directory contains example evidence from running the omp verification script.

## Structure

```
evidence/
├── doctor/
│   └── output.txt              # Output from 'omp doctor' command
├── config/
│   ├── list-output.txt        # Output from 'omp config list'
│   └── get-output.txt         # Output from 'omp config get <key>'
├── models/
│   ├── list-output.txt        # Output from 'omp models'
│   └── provider-filter.txt    # Output from 'omp models <provider>'
├── print-mode/
│   └── output.txt             # Output from 'omp -p "..." --no-session'
└── version-help/
    ├── version.txt            # Output from 'omp --version'
    └── help.txt               # Output from 'omp --help'
```

## How Evidence is Generated

Run the verification script with isolated agent directory:

```bash
PI_CODING_AGENT_DIR=/tmp/omp-test-agent .cursor/skills/verify-omp/bin/omp-verify
```

The script:
1. Tests each mapped feature (see `../features/*.md`)
2. Captures output to evidence files
3. Fails hard (exit 1) on any critical failure
4. Preserves evidence for commit/PR proof

## Evidence Requirements

- **Real execution**: Evidence must come from actual omp command runs
- **No mocks**: Don't fake evidence with `--model=mock` or similar
- **Isolation**: Use `PI_CODING_AGENT_DIR` to isolate agent data writes
- **Persistence**: Evidence survives cleanup and can be committed

## Mapped Features

Each feature has a corresponding `.md` file in `../features/`:
- `version-help.md` → `version-help/*.txt`
- `doctor.md` → `doctor/output.txt`
- `models-list.md` → `models/*.txt`
- `config-operations.md` → `config/*.txt`
- `print-mode.md` → `print-mode/output.txt`

See feature maps for testing steps and success criteria.
