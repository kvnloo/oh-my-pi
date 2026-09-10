# Feature: Print Mode (Non-Interactive)

## Sub-features

- `omp -p "prompt text"` — Execute a single prompt in non-interactive mode
- `omp --print "prompt text"` — Long form of print flag
- `omp --no-session` — Prevent session persistence (ephemeral mode)
- Combined usage: `omp -p "prompt" --no-session`

## How to get to it

```bash
# Simple print mode
omp -p "Echo hello world"

# With no-session flag
omp -p "List current directory" --no-session

# Long form
omp --print "Show bun version"
```

## Driving it with the harness

The verification harness tests print mode with timeout protection:

1. Generates a unique test word to verify actual execution
2. Runs `omp -p "Print exactly this word: <UNIQUE>" --no-session` with 60s timeout
3. Captures output to `evidence/print-mode/output.txt`
4. Verifies the output file is non-empty
5. Fails hard (exit 1) if print mode times out or produces empty output

## Gotchas

- Print mode still requires valid model configuration and API keys
- Timeout is set to 60 seconds to prevent hanging in verification
- `--no-session` prevents session persistence (important for non-interactive testing)
- Output goes to stdout; errors to stderr
- May produce substantial output depending on the prompt (TUI rendering, tool execution logs)
