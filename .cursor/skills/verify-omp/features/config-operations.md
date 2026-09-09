# Feature: Configuration Operations

## User Surface

Configuration management commands:
- `omp config list` — List all configuration keys and values
- `omp config get <key>` — Get a specific configuration value
- `omp config set <key> <value>` — Set a configuration value

## What It Does

- Manages agent configuration in `~/.omp/agent/config.yml` (or `PI_CODING_AGENT_DIR/config.yml`)
- Provides read/write access to configuration settings
- Lists all available configuration options
- Validates configuration values

## How to Test

```bash
# List all config
omp config list

# Get specific value
omp config get default_model

# Set a test value (if supported)
omp config set test_key test_value

# Verify it was set
omp config get test_key
```

## Success Criteria

- `list` command shows configuration keys
- `get` command retrieves values without error
- `set` command (if implemented) persists values
- Commands respect `PI_CODING_AGENT_DIR` when set

## Evidence Path

`.cursor/skills/verify-omp/evidence/config/list-output.txt`
`.cursor/skills/verify-omp/evidence/config/get-output.txt`
