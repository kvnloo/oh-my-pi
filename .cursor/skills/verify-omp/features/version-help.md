# Feature: Version and Help Output

## User Surface

Basic CLI information commands:
- `omp --version` — Display version information
- `omp --help` — Display help text and available commands

## What It Does

- `--version`: Prints the installed omp version number
- `--help`: Shows usage information, available commands, and flags
- Both are fundamental CLI commands that should always work

## How to Test

```bash
# Version check
omp --version

# Help output
omp --help

# Command-specific help
omp doctor --help
omp models --help
omp config --help
```

## Success Criteria

- `--version` prints a valid semantic version string
- `--help` displays comprehensive usage information
- Command lists show expected commands (doctor, models, config, etc.)
- Exit code is 0 for both commands
- Output is properly formatted and readable

## Evidence Path

`.cursor/skills/verify-omp/evidence/version-help/version.txt`
`.cursor/skills/verify-omp/evidence/version-help/help.txt`
