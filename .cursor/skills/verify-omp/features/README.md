# omp verification map

This directory is the maintained source for verifying the user-facing behavior of omp (oh-my-pi coding agent). Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Workspace root is `/workspace` (oh-my-pi monorepo)
- Dependencies installed: `bun install` completed successfully
- Native addons built: `bun --cwd=packages/natives run build` completed successfully
- Bun runtime available: `$HOME/.bun/bin/bun` exists and is in `PATH`
- Test isolation: Use `OMP_AGENT_DIR=/tmp/verify-omp-$$` for disposable agent directories
- Headless mode: Set `PI_TEST_RUNTIME=1` to disable certain TUI features that require real terminals

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise
- Run all commands from `/workspace` (monorepo root)
- Use `bun packages/coding-agent/src/cli.ts` as the entry point (not a built binary)
- For interactive TUI testing, use tmux with session names like `verify-omp-$$` to avoid collisions
- Prefer `--no-session` flag to avoid persisting test sessions to disk
- Use `--model=mock` or omit model flags when testing non-LLM features
- Treat command-line flags as literal. Keep quoted values unchanged.

## Proof and skip reporting

- Capture the user action (command invoked) and the resulting state (output, exit code, side effects)
- Print mode proof includes stdout, stderr, and exit code
- TUI proof includes terminal capture or tmux pane snapshot
- Subcommand proof includes command, output, and exit code
- Record the feature ID and entry point used with every artifact
- Report an unreachable path with the attempted command and the unmet precondition (e.g., missing auth, external service required)
- Do not report a skipped entry point as verified through a different path

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior
2. `How to get to it (user POV)` lists every user entry point
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result
4. `Gotchas` lists traps that can waste or invalidate a verification run

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Print mode execution](./print-mode.md) covers non-interactive (`-p` / `--print`) one-shot prompt execution with stdout/stderr capture
- [Interactive TUI launch](./interactive-tui.md) covers launching the interactive terminal UI, sending input, and observing output
- [Config management](./config-management.md) covers the `config` subcommand for listing, getting, and setting configuration values
- [Tool execution](./tool-execution.md) covers built-in tools (read, write, grep, etc.) invoked through print mode
- [Session management](./session-management.md) covers `--resume`, `--continue`, and `--no-session` flags
