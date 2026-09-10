# oh-my-pi Verification Evidence

This directory contains proof-of-execution artifacts from running the omp verification harness against a real installation.

## Purpose

Evidence files serve as:
1. **Regression tracking** — Committed artifacts prove features worked at verification time
2. **Documentation** — Real command output shows actual behavior, not assumed behavior
3. **Bug reproduction** — When verification fails, evidence captures the failure state

## Structure

```
evidence/
├── version-help/          # Basic CLI info commands
│   ├── version.txt        # Output of `omp --version`
│   └── help.txt           # Output of `omp --help`
├── plugin-doctor/         # Plugin subsystem diagnostics
│   ├── output.txt         # Output of `omp plugin doctor`
│   └── list.txt           # Output of `omp plugin list`
├── models/                # Model discovery
│   ├── list-output.txt    # Output of `omp models`
│   └── provider-filter.txt # Output of `omp models anthropic`
├── config/                # Configuration operations
│   ├── list-output.txt    # Output of `omp config list`
│   ├── get-output.txt     # Output of `omp config get theme`
│   ├── path-output.txt    # Output of `omp config path`
│   └── real-agent-after.txt # Listing of ~/.omp/agent after tests
└── print-mode/            # Non-interactive print mode
    └── output.txt         # Output of `omp -p "test" --no-session`
```

## Guidelines

### DO Commit

- Real command output from actual omp execution
- Empty files with explanatory comments (e.g., "skipped: no API keys")
- Error messages that document expected failures (e.g., missing plugins)

### DO NOT Commit

- Fabricated or templated output
- Fake config keys that don't exist in omp (e.g., `default_model`, `enable_tui`)
- Evidence from `$PI_CODING_AGENT_DIR` or temp directories
- Sensitive data (API keys, auth tokens, personal paths)

### Regeneration

To regenerate evidence on your system:

```bash
# From repo root
.cursor/skills/verify-omp/bin/omp-verify

# Evidence files updated in place
git status .cursor/skills/verify-omp/evidence/
```

## Current Status

This evidence tree was last generated against:
- Commit: (to be filled by verification run)
- Environment: (to be filled by verification run)
- Date: (to be filled by verification run)

Status: **PENDING** — Evidence from real execution needed (current files are placeholders).
