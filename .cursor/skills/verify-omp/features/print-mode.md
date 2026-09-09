# Print mode execution

Print mode (`-p` / `--print`) executes a single prompt non-interactively and exits. The agent processes the prompt, executes any tool calls if needed, and writes output to stdout before terminating with an exit code.

## Sub-features

- `print-basic` executes a simple prompt and returns output
- `print-exit-code` returns exit code 0 on success
- `print-stderr` writes errors to stderr if the prompt fails
- `print-no-tui` does not render TUI interface, only text output

## How to get to it (user POV)

- Run `omp -p "your prompt here"` from a terminal
- Run `omp --print "your prompt here"` (long form)
- Pass additional flags like `--model`, `--no-session`, `--no-tools` to customize behavior

## Driving it with shell commands

Preconditions:

- Workspace is `/workspace` with dependencies and native addons built
- Bun is available at `$HOME/.bun/bin/bun` or in `PATH`
- No authentication required for basic print mode execution

### Basic print mode execution

**Invoke print mode.** Run a simple prompt.

```bash
export PATH="$HOME/.bun/bin:$PATH"
OUTPUT=$(bun packages/coding-agent/src/cli.ts -p "What is 2+2?" --no-session 2>&1)
EXIT_CODE=$?
```

Result: `$OUTPUT` contains agent response text, `$EXIT_CODE` is 0.

**Capture output.** Save stdout and stderr separately.

```bash
bun packages/coding-agent/src/cli.ts -p "List the README.md file" --no-session \
  > .cursor/skills/verify-omp/evidence/print-mode/stdout.txt \
  2> .cursor/skills/verify-omp/evidence/print-mode/stderr.txt
echo $? > .cursor/skills/verify-omp/evidence/print-mode/exit-code.txt
```

Result: Three files created with output, errors, and exit code.

**Verify exit code.** Exit code 0 indicates success.

```bash
EXIT_CODE=$(cat .cursor/skills/verify-omp/evidence/print-mode/exit-code.txt)
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "PASS: Print mode succeeded"
else
  echo "FAIL: Print mode exit code $EXIT_CODE"
fi
```

Result: Exit code check passes.

**Verify no TUI.** Print mode should not render TUI, only text.

```bash
STDOUT=$(cat .cursor/skills/verify-omp/evidence/print-mode/stdout.txt)
# Check that output does not contain ANSI escape codes for TUI rendering
# (basic heuristic: no cursor positioning codes)
if echo "$STDOUT" | grep -qE '\x1b\[[0-9;]*[HJ]'; then
  echo "WARN: TUI escape codes detected in print mode"
else
  echo "PASS: No TUI rendering in print mode"
fi
```

Result: No TUI escape codes found.

## Gotchas

- Print mode may still output ANSI color codes (for syntax highlighting or emphasis), but should not render a full TUI with cursor positioning
- Some prompts may require authentication (e.g., if they call external APIs). Use `--no-tools` or ensure offline mode for pure verification
- Exit code may be non-zero if the prompt itself contains an error or if tool execution fails (this is expected behavior)
- Capturing stdout/stderr: use `2>&1` to merge, or separate redirects for precise capture
- Print mode with `--model=mock` or without model config may require a mock provider setup or may fail if no default model is available. Check that the environment allows headless execution
