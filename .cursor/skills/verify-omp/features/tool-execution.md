# Tool execution

omp provides built-in tools that the agent can invoke to interact with the filesystem, execute code, search, and more. Tools include `read`, `write`, `edit`, `grep`, `glob`, `bash`, `eval`, and many others. Tool execution can be verified in print mode by prompting the agent to perform actions that require tool use.

## Sub-features

- `tool-read` reads file contents
- `tool-grep` searches for patterns in files
- `tool-glob` finds files matching patterns
- `tool-bash` executes shell commands (if enabled)
- `tool-disabled` respects `--no-tools` flag

## How to get to it (user POV)

- Prompt omp to read a file: `omp -p "Read the README.md file"`
- Prompt omp to search: `omp -p "Find all TypeScript files"`
- Prompt omp to execute a command: `omp -p "Run ls -la"`
- Disable tools with `--no-tools` flag

## Driving it with shell commands

Preconditions:

- Workspace is `/workspace` with dependencies and native addons built
- Bun is available in `PATH`
- Target files exist for tool operations (e.g., `README.md` for read, `.ts` files for glob)
- For bash tool testing, ensure the agent has permission to execute shell commands (or use approval mode)

### Read tool execution

**Prompt agent to read a file.**

```bash
export PATH="$HOME/.bun/bin:$PATH"
bun packages/coding-agent/src/cli.ts -p "Read the README.md file" --no-session \
  > .cursor/skills/verify-omp/evidence/tool-execution/read-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/tool-execution/read-exit-code.txt
```

Result: Output contains README.md content summary, exit code 0.

**Verify tool invocation.** Check that the agent actually called the read tool.

```bash
# The output should mention the file content or explicitly state it read README.md
if grep -qi "readme\|oh-my-pi\|coding.agent" .cursor/skills/verify-omp/evidence/tool-execution/read-output.txt; then
  echo "PASS: Read tool executed and returned file content"
else
  echo "FAIL: Read tool did not execute or output missing"
fi
```

Result: File content detected in output.

### Grep tool execution

**Prompt agent to search for a pattern.**

```bash
bun packages/coding-agent/src/cli.ts -p "Search for the word 'coding' in all markdown files" --no-session \
  > .cursor/skills/verify-omp/evidence/tool-execution/grep-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/tool-execution/grep-exit-code.txt
```

Result: Output lists files or matches containing "coding", exit code 0.

**Verify grep results.** Check for expected matches.

```bash
if grep -qi "README.md\|DEVELOPMENT.md\|coding" .cursor/skills/verify-omp/evidence/tool-execution/grep-output.txt; then
  echo "PASS: Grep tool executed and returned matches"
else
  echo "FAIL: Grep tool did not execute or no matches found"
fi
```

Result: Grep matches found.

### Glob tool execution

**Prompt agent to find files by pattern.**

```bash
bun packages/coding-agent/src/cli.ts -p "List all TypeScript files in packages/coding-agent/src" --no-session \
  > .cursor/skills/verify-omp/evidence/tool-execution/glob-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/tool-execution/glob-exit-code.txt
```

Result: Output lists `.ts` files, exit code 0.

**Verify glob results.** Check for expected file listings.

```bash
if grep -qi "\.ts\|cli\.ts\|main\.ts\|index\.ts" .cursor/skills/verify-omp/evidence/tool-execution/glob-output.txt; then
  echo "PASS: Glob tool executed and returned file list"
else
  echo "FAIL: Glob tool did not execute or no files found"
fi
```

Result: TypeScript files listed.

### Disabled tools

**Invoke omp with --no-tools.**

```bash
bun packages/coding-agent/src/cli.ts -p "Read the README.md file" --no-session --no-tools \
  > .cursor/skills/verify-omp/evidence/tool-execution/no-tools-output.txt 2>&1
echo $? > .cursor/skills/verify-omp/evidence/tool-execution/no-tools-exit-code.txt
```

Result: Output indicates tools are disabled, or agent cannot fulfill request, exit code may be non-zero or agent explains limitation.

**Verify tools disabled.** Check that agent did not execute tools.

```bash
# With --no-tools, the agent should not be able to read the file
# It may respond with an error or explanation
if grep -qi "cannot\|unable\|no tools\|disabled" .cursor/skills/verify-omp/evidence/tool-execution/no-tools-output.txt; then
  echo "PASS: Tools disabled as expected"
else
  echo "WARN: Expected indication of disabled tools, check output manually"
fi
```

Result: Agent indicates tools are unavailable.

## Gotchas

- Tool execution depends on agent model behavior. Some models may refuse to call tools, or call them incorrectly. Use well-known models for verification, or mock responses
- `--no-tools` disables all built-in tools. The agent can only respond with text, no file operations or code execution
- Bash tool execution may require approval or be disabled by default in certain modes. Check `tools.approvalMode` setting
- Tool outputs are often summarized by the agent, not returned verbatim. Verify by checking for key content, not exact file dumps
- If a tool fails (e.g., file not found), the agent should report the error. Verify error handling by intentionally requesting a nonexistent file
- Evidence captures agent responses, not raw tool outputs. To verify tool behavior deeply, inspect agent's explanation or summary
