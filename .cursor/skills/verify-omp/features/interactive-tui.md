# Interactive TUI launch

Interactive TUI mode is the default omp behavior when invoked without `-p`. The agent renders a terminal-based UI with prompt input, response display, status indicators, and interactive controls (keyboard shortcuts, menus).

## Sub-features

- `tui-launch` starts the TUI interface
- `tui-prompt` accepts user input and displays agent responses
- `tui-exit` exits cleanly on Ctrl+C or quit command
- `tui-headless` runs in headless mode for testing when `PI_TEST_RUNTIME=1` is set

## How to get to it (user POV)

- Run `omp` from a terminal
- Run `omp "initial prompt"` to start with a message
- The TUI appears with a prompt field, history, and status line

## Driving it with tmux

Preconditions:

- Workspace is `/workspace` with dependencies and native addons built
- Bun is available in `PATH`
- tmux is available (standard in test environment)
- Use `PI_TEST_RUNTIME=1` to enable headless mode for programmatic testing

### Launch TUI in tmux

**Start tmux session.** Create a detached session running omp.

```bash
export PATH="$HOME/.bun/bin:$PATH"
SESSION_NAME="verify-omp-tui-$$"

tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" \
  -c /workspace -- bash -c "export PATH=\"$HOME/.bun/bin:$PATH\" OMP_AGENT_DIR=\"/tmp/verify-omp-$$\" PI_TEST_RUNTIME=1 && bun packages/coding-agent/src/cli.ts --no-session"
```

Result: Tmux session `verify-omp-tui-$$` is running omp in TUI mode.

**Wait for startup.** Give omp time to initialize the TUI.

```bash
sleep 3
```

Result: TUI should be ready to accept input.

**Verify session is alive.** Check that the tmux session is still running (omp hasn't crashed).

```bash
if tmux -f /exec-daemon/tmux.portal.conf has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "PASS: TUI session is alive"
else
  echo "FAIL: TUI session terminated unexpectedly"
fi
```

Result: Session exists.

**Send input to TUI.** Type a prompt and press Enter.

```bash
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" "Hello, omp!" C-m
sleep 2
```

Result: Input sent to the TUI.

**Capture TUI output.** Capture the terminal pane content.

```bash
mkdir -p .cursor/skills/verify-omp/evidence/interactive-tui
tmux -f /exec-daemon/tmux.portal.conf capture-pane -t "$SESSION_NAME:0.0" -p \
  > .cursor/skills/verify-omp/evidence/interactive-tui/session-transcript.txt
```

Result: TUI output saved to evidence file.

**Verify response.** Check that the TUI responded to the input.

```bash
if grep -qi "hello\|omp\|assistant" .cursor/skills/verify-omp/evidence/interactive-tui/session-transcript.txt; then
  echo "PASS: TUI responded to input"
else
  echo "FAIL: No response detected in TUI output"
fi
```

Result: Response found in transcript.

**Exit TUI.** Send Ctrl+C to exit gracefully.

```bash
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" C-c
sleep 1
```

Result: TUI exits.

**Verify clean exit.** Check that the session terminated.

```bash
if ! tmux -f /exec-daemon/tmux.portal.conf has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "PASS: TUI exited cleanly"
else
  echo "WARN: TUI session still running, may not have exited properly"
  tmux -f /exec-daemon/tmux.portal.conf kill-session -t "$SESSION_NAME"
fi
```

Result: Session no longer exists (clean exit).

## Gotchas

- TUI rendering requires a terminal with ANSI support. In headless test mode (`PI_TEST_RUNTIME=1`), the TUI may render simplified output or disable certain interactive features
- Tmux pane captures may include ANSI escape codes. Use `col -b` or similar tools to strip codes if analyzing plain text
- Input timing: after `send-keys`, allow sleep time for the agent to process (especially if it calls external models or tools)
- If omp requires authentication or API keys for model access, it may prompt interactively or fail to start. Use `--no-session` and `--no-tools` or configure offline mode for pure TUI verification
- Ctrl+C sends SIGINT. If the TUI has a shutdown handler, it should exit cleanly. Verify no zombie processes remain
- Tmux session names: use unique names (e.g., `$$` shell PID) to avoid collisions with other verification runs or user sessions
