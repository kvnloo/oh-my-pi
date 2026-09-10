# Feature: Configuration Operations

## Sub-features

- `omp config list` — List all configuration keys and current values
- `omp config get <key>` — Get a specific configuration value
- `omp config set <key> <value>` — Set a configuration value
- `omp config reset <key>` — Reset a key to default
- `omp config path` — Show configuration file path
- `omp config init-xdg` — Initialize XDG configuration directories

## How to get to it

```bash
# List all config
omp config list

# Get specific value
omp config get theme

# Set a value in isolated test directory
PI_CODING_AGENT_DIR=/tmp/omp-test-$$ omp config set theme dark

# Show config path
omp config path
```

## Driving it with the harness

The verification harness tests config operations under an isolated `PI_CODING_AGENT_DIR`:

1. Sets `PI_CODING_AGENT_DIR` to a disposable temp directory
2. Runs `omp config list` and captures output to `evidence/config/list-output.txt`
3. Runs `omp config get theme` and captures to `evidence/config/get-output.txt`
4. Runs `omp config path` to verify the isolated directory is used
5. Lists `~/.omp/agent` after tests to prove the real config was untouched
6. Fails hard (exit 1) if any config command fails

## Gotchas

- Config commands respect `PI_CODING_AGENT_DIR` environment variable
- First run may initialize default config.yml automatically
- Some keys may not exist in fresh installations
- Config path differs: `~/.omp/agent/config.yml` vs `PI_CODING_AGENT_DIR/config.yml`
- The harness MUST NOT modify the user's real `~/.omp/agent` directory
