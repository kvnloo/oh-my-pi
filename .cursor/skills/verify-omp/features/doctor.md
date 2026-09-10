# Feature: Plugin Doctor

## Sub-features

- `omp plugin doctor` — Diagnose plugin installation issues
- `omp plugin doctor --fix` — Attempt to fix detected issues
- `omp plugin list` — List installed plugins

## How to get to it

```bash
# Run plugin diagnostics
omp plugin doctor

# Run with auto-fix
omp plugin doctor --fix

# List plugins
omp plugin list
```

## Driving it with the harness

The verification harness tests the plugin subsystem:

1. Runs `omp plugin doctor` and captures output to `evidence/plugin-doctor/output.txt`
2. Runs `omp plugin list` and captures to `evidence/plugin-doctor/list.txt`
3. Treats "no plugins installed" as success (fresh installation expected)
4. Fails hard (exit 1) only if the command itself is broken

## Gotchas

- Fresh installations may have no plugins (expected state)
- Plugin directory may not exist until first plugin is installed
- Some plugin features require internet access for remote plugin repositories
- `--fix` flag modifies plugin state (not used in read-only verification)
