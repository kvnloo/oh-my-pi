---
name: verify-omp
description: "Verification skill for oh-my-pi coding-agent (omp) — drives the CLI/TUI interface like a user would. Use for proving that omp interactive features, print mode, tool execution, and session management work end-to-end."
---

# verify-omp

Verification skill for the oh-my-pi coding agent (`omp`). This skill provides launch, doctor, drive, and cleanup workflows for verifying user-facing features of the omp CLI/TUI.

## Surface

The primary user surface is the `omp` CLI/TUI — an interactive terminal-based coding agent. The agent runs in an interactive TUI mode by default, or in print mode (`-p`) for one-shot execution. The agent can also be invoked with various subcommands for tasks like `config`, `commit`, `grep`, `browse`, etc.

## Launch

The omp CLI is launched via `bun packages/coding-agent/src/cli.ts` from the monorepo root. The repository must have dependencies installed (`bun install`) and native addons built (`bun --cwd=packages/natives run build`).

### Build and install dependencies

```bash
# From workspace root
export PATH="$HOME/.bun/bin:$PATH"
bun install
bun --cwd=packages/natives run build
```

### Environment setup

For isolated testing, omp can use a disposable agent directory:

```bash
export OMP_AGENT_DIR="/tmp/verify-omp-$$"
export PI_TEST_RUNTIME=1  # Signals headless test mode to disable certain TUI features
```

### Launch verification instance

For interactive TUI testing:
```bash
# Start omp in a tmux session for PTY control
SESSION_NAME="verify-omp-$$"
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" -c "$PWD" -- bash -c "export PATH=\"$HOME/.bun/bin:$PATH\" OMP_AGENT_DIR=\"/tmp/verify-omp-$$\" PI_TEST_RUNTIME=1 && bun packages/coding-agent/src/cli.ts --no-session --model=mock"
```

For print mode (non-interactive):
```bash
export PATH="$HOME/.bun/bin:$PATH"
export OMP_AGENT_DIR="/tmp/verify-omp-$$"
bun packages/coding-agent/src/cli.ts -p "List all .ts files in src/" --no-session --model=mock
```

### Readiness check

- **TUI mode**: The session starts and a TUI prompt appears (check tmux pane output)
- **Print mode**: Command completes with exit code 0 and output on stdout
- **Native addon**: No error about missing `pi_natives` module

## Doctor

A read-only health check that confirms the omp installation is usable for verification.

```bash
#!/bin/bash
# verify-omp doctor check

export PATH="$HOME/.bun/bin:$PATH"

# Check bun is available
if ! command -v bun &> /dev/null; then
  echo "FAIL: bun not found in PATH"
  exit 1
fi

# Check workspace root
if [[ ! -f package.json ]] || [[ ! -d packages/coding-agent ]]; then
  echo "FAIL: Not in oh-my-pi workspace root"
  exit 1
fi

# Check dependencies installed
if [[ ! -d node_modules ]]; then
  echo "FAIL: Dependencies not installed (run: bun install)"
  exit 1
fi

# Check native addon exists
if [[ ! -f packages/natives/native/pi_natives.linux-x64-modern.node ]] && \
   [[ ! -f packages/natives/native/pi_natives.linux-x64-baseline.node ]] && \
   [[ ! -f packages/natives/native/pi_natives.linux-x64.node ]]; then
  echo "FAIL: Native addon not built (run: bun --cwd=packages/natives run build)"
  exit 1
fi

# Quick smoke test: run --help
if ! bun packages/coding-agent/src/cli.ts --help &> /dev/null; then
  echo "FAIL: omp --help failed"
  exit 1
fi

echo "PASS: omp is healthy"
exit 0
```

## Drive

Driving omp depends on the mode:

### Print mode (non-interactive)

Print mode is straightforward to drive — invoke with `-p` or `--print` and a prompt:

```bash
export PATH="$HOME/.bun/bin:$PATH"
export OMP_AGENT_DIR="/tmp/verify-omp-$$"

# Example: basic print mode invocation
OUTPUT=$(bun packages/coding-agent/src/cli.ts -p "What is 2+2?" --no-session --model=mock 2>&1)
EXIT_CODE=$?

# Verify exit code and output presence
if [[ $EXIT_CODE -eq 0 ]] && [[ -n "$OUTPUT" ]]; then
  echo "PASS: Print mode executed successfully"
else
  echo "FAIL: Print mode failed with exit code $EXIT_CODE"
fi
```

### Interactive TUI mode (with tmux)

For TUI testing, use tmux to control the session. The repo has existing test harnesses in `packages/coding-agent/test/` that use headless mode (`PI_TEST_RUNTIME=1`).

```bash
SESSION_NAME="verify-omp-$$"

# Launch in tmux
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" \
  -c "$PWD" -- bash -c "export PATH=\"$HOME/.bun/bin:$PATH\" OMP_AGENT_DIR=\"/tmp/verify-omp-$$\" PI_TEST_RUNTIME=1 && bun packages/coding-agent/src/cli.ts --no-session --model=mock"

# Wait for startup (check for prompt or specific output)
sleep 2

# Send input to the session
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" "List files in src/" C-m

# Capture output
sleep 1
tmux -f /exec-daemon/tmux.portal.conf capture-pane -t "$SESSION_NAME:0.0" -p > /tmp/verify-omp-output.txt

# Analyze output for expected content
if grep -q "files" /tmp/verify-omp-output.txt; then
  echo "PASS: TUI responded to input"
else
  echo "FAIL: TUI did not respond"
fi
```

### Subcommands

Many omp subcommands are non-interactive and can be tested directly:

```bash
# config subcommand
bun packages/coding-agent/src/cli.ts config list

# grep subcommand
bun packages/coding-agent/src/cli.ts grep "pattern" packages/coding-agent/src

# commit subcommand (dry-run if possible)
# Note: commit may require git context and auth, use --help to verify syntax
bun packages/coding-agent/src/cli.ts commit --help
```

## Evidence

Evidence captures must survive cleanup. Store all artifacts under `.cursor/skills/verify-omp/evidence/<feature-name>/`:

- **Print mode output**: Capture stdout, stderr, and exit code
- **TUI transcripts**: Capture tmux pane output or terminal file from TUI session
- **Command exit codes**: Record success/failure status
- **Log snippets**: If omp produces logs, capture relevant excerpts showing feature execution
- **Session files**: If `--no-session` is not used, session `.jsonl` files can serve as evidence

### Evidence paths

```
.cursor/skills/verify-omp/evidence/
  print-mode/
    stdout.txt
    stderr.txt
    exit-code.txt
  interactive-tui/
    session-transcript.txt
    screenshot.txt (terminal capture)
  config-list/
    output.txt
  grep-test/
    results.txt
```

Evidence files are never removed by cleanup — only transient test data (temp agent dirs, tmux sessions, temp files) are cleaned up.

## Cleanup

Cleanup removes test artifacts but preserves evidence.

```bash
#!/bin/bash
# verify-omp cleanup

# Kill tmux sessions started by this verification run
if tmux -f /exec-daemon/tmux.portal.conf has-session -t "verify-omp-$$" 2>/dev/null; then
  tmux -f /exec-daemon/tmux.portal.conf kill-session -t "verify-omp-$$"
  echo "Killed tmux session verify-omp-$$"
fi

# Remove temporary agent directories
if [[ -d "/tmp/verify-omp-$$" ]]; then
  rm -rf "/tmp/verify-omp-$$"
  echo "Removed temp agent dir /tmp/verify-omp-$$"
fi

# Remove temp output files (but NOT evidence files)
rm -f /tmp/verify-omp-output.txt

# Evidence files under .cursor/skills/verify-omp/evidence/ are intentionally preserved

echo "Cleanup complete. Evidence preserved in .cursor/skills/verify-omp/evidence/"
```

## Helpers

### `check-omp-ready.sh`

Check if omp can run (dependencies, native addon, etc.)

```bash
#!/bin/bash
export PATH="$HOME/.bun/bin:$PATH"
cd /workspace || exit 1

if ! command -v bun &> /dev/null; then
  echo "ERROR: bun not found"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "ERROR: node_modules missing, run: bun install"
  exit 1
fi

# Try a quick --help invocation
if bun packages/coding-agent/src/cli.ts --help &> /dev/null; then
  echo "OK: omp is ready"
  exit 0
else
  echo "ERROR: omp --help failed"
  exit 1
fi
```

Make executable:
```bash
chmod +x .cursor/skills/verify-omp/check-omp-ready.sh
```

Invoke:
```bash
./.cursor/skills/verify-omp/check-omp-ready.sh
```

## Feature map

See `.cursor/skills/verify-omp/features/README.md` for the maintained map of user-facing features and how to verify them.
