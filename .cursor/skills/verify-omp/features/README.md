# oh-my-pi Feature Verification Maps

This directory contains verification maps for oh-my-pi core features. Each feature map documents the user surface, testing methodology, and expected evidence artifacts.

## Structure

Each feature map follows a standard structure:

### Required Sections

#### Sub-features
List of specific capabilities under this feature area.

#### How to get to it
Command-line invocation, flags, arguments, and access patterns.

#### Driving it with the harness
Step-by-step testing instructions for the verification harness (`bin/omp-verify`).

#### Gotchas
Edge cases, limitations, environment dependencies, and known issues.

## Available Feature Maps

- `version-help.md` — Basic CLI info commands (`--version`, `--help`)
- `config-operations.md` — Configuration management (`config list`, `config get`, `config set`)
- `models-list.md` — Model discovery and provider listing (`models`)

## Testing Philosophy

Feature maps test **real commands against real installations**. Evidence must be:
- Generated from actual command execution
- Reproducible on any valid omp installation
- Committed to the evidence tree for regression tracking
- Never fabricated or templated

When bun or omp are unavailable, the harness exits with code 2 (INCONCLUSIVE) and reports the exact blocker. It never creates fake files or theater output.
