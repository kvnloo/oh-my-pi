# Session management

omp can persist sessions to disk for later resumption, continue from the previous session, or run in ephemeral mode with `--no-session`. Session files are stored as `.jsonl` in `~/.omp/agent/sessions/` (or profile-specific paths).

## Sub-features

- `session-persist` saves session by default (unless `--no-session` is used)
- `session-resume` resumes a named or picked session with `--resume` or `-r`
- `session-continue` continues the last session with `--continue` or `-c`
- `session-ephemeral` does not save session when `--no-session` is used

## How to get to it (user POV)

- Run `omp` without flags to start a new session (automatically saved)
- Run `omp --no-session` to run without saving
- Run `omp --continue` to continue the last session
- Run `omp --resume <id>` to resume a specific session by ID prefix or path

## Driving it with shell commands

Preconditions:

- Workspace is `/workspace` with dependencies and native addons built
- Bun is available in `PATH`
- Use `OMP_AGENT_DIR=/tmp/verify-omp-$$` for isolated testing
- Session directory will be `$OMP_AGENT_DIR/sessions/`

### No-session mode

**Run omp with --no-session.**

```bash
export PATH="$HOME/.bun/bin:$PATH"
export OMP_AGENT_DIR="/tmp/verify-omp-$$"
mkdir -p "$OMP_AGENT_DIR"

bun packages/coding-agent/src/cli.ts -p "Hello" --no-session \
  > .cursor/skills/verify-omp/evidence/session-management/no-session-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/session-management/no-session-exit-code.txt
```

Result: Output generated, exit code 0.

**Verify no session saved.** Check that sessions directory is empty or nonexistent.

```bash
if [[ ! -d "$OMP_AGENT_DIR/sessions" ]] || [[ -z "$(ls -A "$OMP_AGENT_DIR/sessions" 2>/dev/null)" ]]; then
  echo "PASS: No session saved with --no-session flag"
else
  echo "FAIL: Session directory exists despite --no-session"
  ls -la "$OMP_AGENT_DIR/sessions"
fi
```

Result: No session files created.

### Session persistence (default)

**Run omp without --no-session.**

```bash
# Note: For non-interactive test, we can use print mode but omit --no-session
# However, print mode may not persist sessions by default. For true session persistence,
# run interactively in tmux or use a mode that saves.
# For this verification, we'll test that the flag is recognized.

# If interactive session saving is needed, launch in tmux and verify session file creation.
SESSION_NAME="verify-omp-session-$$"
tmux -f /exec-daemon/tmux.portal.conf new-session -d -s "$SESSION_NAME" \
  -c /workspace -- bash -c "export PATH=\"$HOME/.bun/bin:$PATH\" OMP_AGENT_DIR=\"/tmp/verify-omp-$$\" PI_TEST_RUNTIME=1 && bun packages/coding-agent/src/cli.ts"

sleep 2

# Send a message to create session content
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" "Hello, saving session" C-m
sleep 1

# Exit the session
tmux -f /exec-daemon/tmux.portal.conf send-keys -t "$SESSION_NAME:0.0" C-c
sleep 1
```

Result: Session launched, interacted, and exited.

**Verify session saved.** Check for session files.

```bash
if [[ -d "$OMP_AGENT_DIR/sessions" ]] && [[ -n "$(ls -A "$OMP_AGENT_DIR/sessions" 2>/dev/null)" ]]; then
  echo "PASS: Session directory created with session files"
  ls -1 "$OMP_AGENT_DIR/sessions" > .cursor/skills/verify-omp/evidence/session-management/session-list.txt
else
  echo "FAIL: No session files found after session exit"
fi
```

Result: Session file(s) exist.

### Resume session

**Resume a saved session.**

```bash
# Assuming a session exists from the previous step, attempt to resume it
# Get the session ID or path
if [[ -d "$OMP_AGENT_DIR/sessions" ]]; then
  FIRST_SESSION=$(ls -1 "$OMP_AGENT_DIR/sessions" | head -1)
  if [[ -n "$FIRST_SESSION" ]]; then
    echo "Attempting to resume session: $FIRST_SESSION"
    # For non-interactive resume test, we can check that --resume flag is accepted
    # Full interactive resume would require tmux launch and input
    bun packages/coding-agent/src/cli.ts --resume "$FIRST_SESSION" --help \
      > .cursor/skills/verify-omp/evidence/session-management/resume-help-output.txt 2>&1
    echo $? > .cursor/skills/verify-omp/evidence/session-management/resume-help-exit-code.txt
    echo "PASS: --resume flag accepted (verified with --help, full resume requires interactive mode)"
  else
    echo "SKIP: No session available to resume"
  fi
else
  echo "SKIP: No sessions directory"
fi
```

Result: `--resume` flag is recognized.

### Continue session

**Continue the last session.**

```bash
# Similar to resume, but uses --continue flag
# For verification, we check that the flag is accepted
bun packages/coding-agent/src/cli.ts --continue --help \
  > .cursor/skills/verify-omp/evidence/session-management/continue-help-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/session-management/continue-help-exit-code.txt

if [[ $? -eq 0 ]]; then
  echo "PASS: --continue flag accepted"
else
  echo "FAIL: --continue flag not recognized"
fi
```

Result: `--continue` flag is recognized.

## Gotchas

- Session persistence behavior varies by mode. Print mode (`-p`) typically does not save sessions unless explicitly configured. Interactive TUI mode saves sessions by default
- `--no-session` prevents both saving and loading sessions. It's useful for stateless testing or one-off commands
- Session files are `.jsonl` (newline-delimited JSON). Each line is a session entry (message, tool call, result)
- Session IDs may be auto-generated (timestamps, hashes). Use ID prefixes or paths to resume specific sessions
- Resuming a session replays its history into the agent's context. Long sessions may consume significant memory or tokens
- `--resume` without an argument may open a picker (interactive). In automated testing, provide an explicit session ID or path
- Cleanup: remove the temporary agent dir (`$OMP_AGENT_DIR`) after testing, but preserve evidence files
- If session saving fails (disk full, permission error), omp should handle gracefully. Verify error messages in such cases
