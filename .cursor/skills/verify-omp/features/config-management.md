# Config management

The `omp config` subcommand manages configuration settings stored in `~/.omp/config.yml` (or profile-specific paths). Users can list all settings, get a specific value, set a value, or reset to defaults.

## Sub-features

- `config-list` displays all current settings
- `config-get` retrieves a specific setting value
- `config-set` updates a setting value
- `config-help` shows usage for the config subcommand

## How to get to it (user POV)

- Run `omp config list` to see all settings
- Run `omp config get <key>` to retrieve a specific setting
- Run `omp config set <key> <value>` to update a setting
- Run `omp config --help` for command usage

## Driving it with shell commands

Preconditions:

- Workspace is `/workspace` with dependencies and native addons built
- Bun is available in `PATH`
- For isolated testing, use `OMP_AGENT_DIR=/tmp/verify-omp-$$` to avoid modifying user's real config
- Config file may not exist initially (omp creates default on first access)

### List all config settings

**Invoke config list.** Display all settings.

```bash
export PATH="$HOME/.bun/bin:$PATH"
export OMP_AGENT_DIR="/tmp/verify-omp-$$"
mkdir -p "$OMP_AGENT_DIR"

bun packages/coding-agent/src/cli.ts config list \
  > .cursor/skills/verify-omp/evidence/config-management/list-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/config-management/list-exit-code.txt
```

Result: Settings listed in output file, exit code 0.

**Verify list output.** Check that output contains expected config keys.

```bash
if grep -qi "model\|provider\|theme\|tools" .cursor/skills/verify-omp/evidence/config-management/list-output.txt; then
  echo "PASS: Config list contains expected keys"
else
  echo "FAIL: Config list output missing expected keys"
fi
```

Result: Config keys found.

### Get a specific setting

**Invoke config get.** Retrieve a setting value.

```bash
bun packages/coding-agent/src/cli.ts config get startup.quiet \
  > .cursor/skills/verify-omp/evidence/config-management/get-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/config-management/get-exit-code.txt
```

Result: Setting value or default displayed, exit code 0.

**Verify get output.** Check that output is a valid value (true/false/string/number).

```bash
VALUE=$(cat .cursor/skills/verify-omp/evidence/config-management/get-output.txt | tr -d '\n' | tr -d ' ')
if [[ "$VALUE" =~ ^(true|false|[0-9]+|\".*\")$ ]]; then
  echo "PASS: Config get returned a valid value: $VALUE"
else
  echo "INFO: Config get returned: $VALUE (may be null or unset)"
fi
```

Result: Value is valid or indicates unset.

### Set a config value

**Invoke config set.** Update a setting.

```bash
bun packages/coding-agent/src/cli.ts config set startup.quiet true \
  > .cursor/skills/verify-omp/evidence/config-management/set-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/config-management/set-exit-code.txt
```

Result: Setting updated, exit code 0.

**Verify set persisted.** Read back the setting to confirm change.

```bash
NEW_VALUE=$(bun packages/coding-agent/src/cli.ts config get startup.quiet 2>&1 | tr -d '\n' | tr -d ' ')
if [[ "$NEW_VALUE" == "true" ]]; then
  echo "PASS: Config set persisted (startup.quiet=true)"
else
  echo "FAIL: Config set did not persist (got: $NEW_VALUE)"
fi
```

Result: Setting persisted.

### Display config help

**Invoke config help.** Show subcommand usage.

```bash
bun packages/coding-agent/src/cli.ts config --help \
  > .cursor/skills/verify-omp/evidence/config-management/help-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/config-management/help-exit-code.txt
```

Result: Help text displayed, exit code 0.

**Verify help output.** Check for expected usage information.

```bash
if grep -qi "USAGE\|COMMANDS\|list\|get\|set" .cursor/skills/verify-omp/evidence/config-management/help-output.txt; then
  echo "PASS: Config help contains usage information"
else
  echo "FAIL: Config help missing expected content"
fi
```

Result: Help content is valid.

## Gotchas

- Config file location depends on `OMP_AGENT_DIR` or defaults to `~/.omp/`. Always set `OMP_AGENT_DIR` for isolated testing to avoid modifying the user's real config
- Some settings may require specific formats (YAML strings, booleans, numbers). Invalid values may be rejected or cause parsing errors
- Config keys use dot notation (e.g., `startup.quiet`, `tools.approvalMode`). Ensure correct casing and syntax
- `config list` may output YAML or formatted text. Verify by checking for recognizable keys, not exact format
- `config get` for an unset key may return empty output, `null`, or an error. Both behaviors are valid (depends on implementation)
- `config set` may not validate values until omp runs with the new setting. A successful `set` does not guarantee the value is semantically valid
- Cleanup: remove the temporary agent dir (`$OMP_AGENT_DIR`) after testing, but preserve evidence files
