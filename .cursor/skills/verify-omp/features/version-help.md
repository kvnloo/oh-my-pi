# Feature: Version and Help Output

## Sub-features

- `omp --version` — Display version information
- `omp --help` — Display help text and available commands
- Command-specific help (e.g., `omp config --help`)

## How to get to it

```bash
# Version check
omp --version

# Top-level help
omp --help

# Command-specific help
omp config --help
omp models --help
```

## Driving it with the harness

The verification harness (`bin/omp-verify`) tests version and help:

1. Runs `omp --version` and captures output to `evidence/version-help/version.txt`
2. Runs `omp --help` and captures output to `evidence/version-help/help.txt`
3. Validates that help contains "usage" or "Usage" string
4. Fails hard (exit 1) if either command fails

## Gotchas

- In source mode (no installed binary), harness uses `bun dev -- --version`
- Help output format may vary between versions
- Some commands may not have `--help` flag; use `omp help <command>` instead
