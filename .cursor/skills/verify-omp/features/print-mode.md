# Feature: Print Mode (Non-Interactive)

## User Surface

`omp -p "prompt text"` or `omp --print "prompt text"` — Execute a single prompt in non-interactive mode and print the result to stdout.

Also: `--no-session` flag to prevent session persistence.

## What It Does

- Accepts a prompt from command line arguments
- Executes the prompt without starting an interactive TUI
- Prints the agent's response to stdout
- Exits after completion
- Useful for scripting and automation

## How to Test

```bash
# Simple test prompt
omp -p "Print the word VERIFICATION" --no-session

# File operation test
omp -p "List files in current directory" --no-session

# With timeout for safety
timeout 60s omp -p "Echo hello" --no-session
```

## Success Criteria

- Command completes without hanging
- Output contains expected response to prompt
- Exit code indicates success (0) or failure (non-zero)
- No interactive UI launched
- Respects `PI_CODING_AGENT_DIR` for any agent data

## Evidence Path

`.cursor/skills/verify-omp/evidence/print-mode/output.txt`
