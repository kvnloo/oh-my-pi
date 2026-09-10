---
name: verify-omp
description: >
  Validate omp installation and core features through systematic testing of
  CLI commands, configuration, and model discovery.
---

# Verify Oh-My-Pi Installation and Core Features

This skill validates a working oh-my-pi (omp) installation through systematic testing of CLI commands and core agent features.

## When to Use

- After installing omp from source, npm, or binaries
- Before submitting changes that affect core workflows
- When debugging installation or runtime issues
- To generate proof of working features for PRs or issues

## Quick Start

### Automated Verification

Run the fail-hard proof script for comprehensive testing:

```bash
# From repo root
.cursor/skills/verify-omp/bin/omp-verify
```

Exit codes:
- `0` = All tests passed
- `1` = Test failure (hard fail on broken feature)
- `2` = Inconclusive (bun/omp not available, honest blocker reported)

### Feature Map

Individual feature verification guides in `features/`:
- `version-help.md` — Basic CLI info commands (`--version`, `--help`)
- `doctor.md` — Plugin diagnostics (`plugin doctor`, `plugin list`)
- `models-list.md` — Model discovery and listing (`models`)
- `config-operations.md` — Config get/set/list/path
- `print-mode.md` — Non-interactive print mode (`-p`)

See `features/README.md` for the standard feature map structure.

## Prerequisites

### Required

- **omp** — Binary in PATH, **or** source checkout with `bun.lock`/`bun.lockb`
- **bun** ≥1.3.14 — Required only for source-mode runs (not needed when `omp` is on PATH)

### Optional

- **git** — For repository-based verification
- **API keys** — For model discovery and print mode tests

### Checking Prerequisites

```bash
# Check bun
bun --version || echo "Install: curl -fsSL https://bun.sh/install | bash"

# Check omp binary
command -v omp && omp --version

# OR check source checkout
[ -f packages/coding-agent/package.json ] && echo "Source mode available"
```

## Feature Testing

### Version and Help

```bash
# Version check
omp --version > .cursor/skills/verify-omp/evidence/version-help/version.txt

# Help output
omp --help > .cursor/skills/verify-omp/evidence/version-help/help.txt
```

### Plugin Doctor

```bash
# Run diagnostics
omp plugin doctor > .cursor/skills/verify-omp/evidence/plugin-doctor/output.txt

# List plugins
omp plugin list > .cursor/skills/verify-omp/evidence/plugin-doctor/list.txt
```

### Models Discovery

```bash
# List all models (may require API keys)
omp models > .cursor/skills/verify-omp/evidence/models/list-output.txt

# Provider-specific
omp models anthropic > .cursor/skills/verify-omp/evidence/models/provider-filter.txt
```

### Config Operations

**CRITICAL**: Config tests MUST use isolated `PI_CODING_AGENT_DIR` to avoid modifying user's real config:

```bash
# Create isolated test directory
TEST_AGENT_DIR="/tmp/omp-verify-agent-$$"
export PI_CODING_AGENT_DIR="$TEST_AGENT_DIR"

# List config
omp config list > .cursor/skills/verify-omp/evidence/config/list-output.txt

# Get a value
omp config get theme.dark > .cursor/skills/verify-omp/evidence/config/get-output.txt

# Show config path
omp config path > .cursor/skills/verify-omp/evidence/config/path-output.txt

# Verify isolation worked
ls -la ~/.omp/agent > .cursor/skills/verify-omp/evidence/config/real-agent-after.txt

# Clean up
rm -rf "$TEST_AGENT_DIR"
```

### Print Mode

```bash
# Simple non-interactive test (requires API keys)
omp -p "Echo hello world" --no-session > .cursor/skills/verify-omp/evidence/print-mode/output.txt
```

## Evidence Collection

### Evidence Base Directory

Evidence is **ALWAYS** committed to:
```
.cursor/skills/verify-omp/evidence/
```

**NEVER** use `$PI_CODING_AGENT_DIR` for evidence. The isolated agent directory is for testing config isolation only.

### Structure

```
.cursor/skills/verify-omp/evidence/
├── version-help/
│   ├── version.txt
│   └── help.txt
├── plugin-doctor/
│   ├── output.txt
│   └── list.txt
├── models/
│   ├── list-output.txt
│   └── provider-filter.txt
├── config/
│   ├── list-output.txt
│   ├── get-output.txt
│   ├── path-output.txt
│   └── real-agent-after.txt
└── print-mode/
    └── output.txt
```

### Committed Evidence

All evidence files under `.cursor/skills/verify-omp/evidence/` should be committed to prove the verification ran against a real omp installation. Never commit:
- Fabricated or templated output
- Fake config keys that don't exist in omp
- Evidence from `$PI_CODING_AGENT_DIR` or temp directories

## Exit Codes and Failure Modes

### Exit 0: Success

All critical features tested successfully:
- Version and help commands work
- Config operations execute (with proper isolation)
- Models command runs (may show empty list without keys)
- Plugin subsystem accessible

### Exit 1: Hard Failure

A feature that should work is broken:
- `omp --version` fails
- `omp --help` produces invalid output
- Config commands fail
- Config isolation violated (modified real `~/.omp/agent`)

### Exit 2: Inconclusive

Environment is not ready, with exact blocker reported:
- `omp not found (neither binary nor source)`
- `bun not found in PATH` (source mode only; binary-mode `omp` on PATH does not need bun)
- `Found monorepo but bun.lock/bun.lockb missing. Run 'bun install' first.`

**NEVER** create fake evidence when inconclusive. Report the blocker honestly and exit.

## Troubleshooting

### bun not found

```bash
# Install bun
curl -fsSL https://bun.sh/install | bash

# Add to PATH
export PATH="$HOME/.bun/bin:$PATH"
```

### omp not found

**Binary install:**
```bash
bun install -g @oh-my-pi/pi-coding-agent
```

**Source mode:**
```bash
cd oh-my-pi
bun install
bun run dev -- --version
```

### Config commands fail

- Check `PI_CODING_AGENT_DIR` is set for tests
- Verify test directory is writable
- Ensure bun can create files in temp locations

### Models list empty

- Expected without API keys configured
- Not a failure; verification only tests that the command runs
- To configure keys: `omp config set anthropic_api_key sk-...`

### Print mode hangs

- Requires valid API keys and model access
- Use timeout: `timeout 60s omp -p "test" --no-session`
- May be skipped in environments without API access

## Notes

- This skill tests the **coding-agent package** implementation, not this assistant
- Evidence is committed to the skill tree for regression tracking
- Config tests use isolation to protect user's real `~/.omp/agent` directory
- API key requirements are documented but not enforced (tests warn, not fail)
- Source mode requires `bun.lockb` (run `bun install` first)
