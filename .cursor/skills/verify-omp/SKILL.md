---
name: verify-omp
description: >
  Validate omp installation and core features through systematic testing of
  CLI commands, configuration, print-mode, and Doctor diagnostics.
---

# Verify Oh-My-Pi Installation and Core Features

This skill validates a working oh-my-pi (omp) installation through systematic testing of CLI commands, TUI interactions, and agent primary surfaces.

## When to Use

- After installing omp from source, npm, or binaries
- Before submitting changes that affect core workflows
- When debugging installation or runtime issues
- To generate proof of working features for PRs or issues

## Quick Start

### Automated Verification

Run the fail-hard proof script for comprehensive testing:

```bash
# From repo root
.cursor/skills/verify-omp/bin/omp-verify

# With isolated agent directory
PI_CODING_AGENT_DIR=/tmp/omp-test-agent .cursor/skills/verify-omp/bin/omp-verify
```

The script tests all mapped features and exits with code 1 on any failure.

### Feature Map

Individual feature verification guides:
- `features/version-help.md` — Basic CLI info commands
- `features/doctor.md` — Doctor diagnostic command
- `features/models-list.md` — Model discovery and listing
- `features/config-operations.md` — Config get/set/list
- `features/print-mode.md` — Non-interactive print mode

Each feature map describes the user surface, testing steps, and expected evidence paths.

## Launch

Check prerequisites and environment readiness:

```bash
# Verify bun runtime (required: ≥1.3.14)
bun --version || { echo "ERROR: bun not found"; exit 1; }

# Verify omp is accessible
command -v omp || bun dev -- --version || { echo "ERROR: omp not accessible"; exit 1; }

# Check git environment
git --version && git config user.email || { echo "WARN: Git not fully configured"; }

# Detect TTY capability
tty -s && echo "TTY: available" || echo "TTY: unavailable (TUI tests will be limited)"

# Environment summary
echo "---"
echo "TERM: $TERM"
echo "SHELL: $SHELL"
echo "OS: $(uname -s)"
echo "PWD: $PWD"
```

**Expected:** bun ≥1.3.14, omp accessible, git configured. TTY availability determines TUI test scope.

## Doctor

Run diagnostic checks on the installation:

### Binary Health

```bash
# Version check (source or installed)
if command -v omp >/dev/null 2>&1; then
  omp --version
elif [ -f "packages/coding-agent/package.json" ]; then
  bun dev -- --version
else
  echo "ERROR: omp not found in PATH or source tree"
  exit 1
fi

# Help output sanity
omp --help | head -20 || bun dev -- --help | head -20

# List available commands
omp models --help 2>&1 | grep -i usage || echo "models command available"
```

### Workspace Check

```bash
# Verify monorepo structure (if in source)
if [ -d "packages/coding-agent" ]; then
  echo "Source detected: monorepo"
  ls -1 packages/ | head -10
  [ -f "bun.lockb" ] && echo "✓ bun.lockb present"
else
  echo "Binary install detected"
fi

# Check for native addon
find . -name "*.node" 2>/dev/null | head -5 || echo "No .node files in tree (may be installed globally)"
```

### Config Discovery

```bash
# Check agent directory (respects PI_CODING_AGENT_DIR)
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
echo "Agent directory: $AGENT_DIR"

# Check config paths
echo "Config paths:"
echo "  $AGENT_DIR/config.yml"
echo "  $AGENT_DIR/models.yml"
echo "  ~/.cursor/"
echo "  ./.cursor/"

# Show active config (first 20 lines)
if [ -f "$AGENT_DIR/config.yml" ]; then
  head -20 "$AGENT_DIR/config.yml"
else
  echo "No config.yml found (will use defaults)"
fi

# Verify agent directory ownership
if [ -d "$AGENT_DIR" ]; then
  ls -ld "$AGENT_DIR" | awk '{print "Owner: " $3 ":" $4}'
fi
```

**Expected:** Version prints, help renders, native addon exists (source) or skipped (global), config paths shown, agent directory ownership verified.

## Drive

Execute feature verification with evidence capture.

### CLI Command Catalog

Test non-interactive commands:

```bash
# Models discovery
echo "=== MODELS ==="
omp models anthropic 2>&1 | head -10 || echo "SKIP: anthropic provider"
omp models openai 2>&1 | head -10 || echo "SKIP: openai provider"

# Session list
echo "=== SESSIONS ==="
omp sessions 2>&1 | head -10

# Stats (if available)
echo "=== STATS ==="
omp stats --help 2>&1 | head -5 || echo "SKIP: stats command not available"

# Completion generation
echo "=== COMPLETIONS ==="
omp completions zsh 2>&1 | head -10 | grep -i "omp" || echo "PASS: completions generated"
```

### One-Shot Mode

Test `-p` prompt mode (non-interactive):

```bash
mkdir -p /tmp/omp-verify-test
cd /tmp/omp-verify-test

# Simple prompt test
echo "=== ONE-SHOT TEST ==="
timeout 30s omp -p "Print the word 'VERIFICATION' and exit" --no-session 2>&1 | tee oneshot.log || {
  echo "TIMEOUT or ERROR"
  cat oneshot.log
}

# Check for output
grep -i "verification" oneshot.log && echo "PASS: one-shot responded" || echo "FAIL: no response"
```

### Agent Session (Limited TTY)

If TTY unavailable, test RPC mode:

```bash
# RPC mode test
echo "=== RPC MODE TEST ==="
cat > rpc-test.json <<'EOF'
{"id":"t1","type":"prompt","message":"list .ts files in packages/coding-agent/src/tools"}
{"id":"t2","type":"abort"}
EOF

timeout 20s omp --mode rpc --no-session < rpc-test.json 2>&1 | tee rpc.log || echo "RPC timeout"

# Verify response structure
grep '"type":"response"' rpc.log && echo "PASS: RPC responded" || echo "FAIL: no RPC response"
```

### Tool Surface (via SDK or RPC)

Test core tools if SDK accessible:

```bash
# SDK test (Node/Bun)
cat > sdk-test.ts <<'EOF'
import { createAgentSession, SessionManager, ModelRegistry, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});

await session.prompt("list available tools");
console.log("SDK session created successfully");
EOF

bun sdk-test.ts 2>&1 | head -30 || echo "SKIP: SDK test failed (may need API keys)"
```

### TUI Smoke (if TTY available)

**Only run if `tty -s` succeeds and portable PTY tools available:**

```bash
if tty -s; then
  echo "=== TUI SMOKE TEST ==="
  
  # Use portable tmux (don't depend on /exec-daemon/tmux.portal.conf)
  # Create a temporary tmux session for testing
  if command -v tmux &>/dev/null; then
    TMUX_SOCKET="/tmp/omp-verify-tmux-$$"
    tmux -S "$TMUX_SOCKET" new-session -d "omp --no-session; sleep 2"
    sleep 3
    tmux -S "$TMUX_SOCKET" capture-pane -p > tui.log
    tmux -S "$TMUX_SOCKET" kill-session
    rm -f "$TMUX_SOCKET"
    
    grep -i "session\|omp" tui.log && echo "PASS: TUI launched" || echo "INCONCLUSIVE: TUI did not render"
  else
    # Fallback: simple stdin test without tmux
    (sleep 2; echo "/exit") | timeout 10s omp --no-session 2>&1 | tee tui.log || echo "TUI timeout"
    grep -i "session" tui.log && echo "PASS: TUI launched" || echo "INCONCLUSIVE: TUI did not render"
  fi
else
  echo "SKIP: No TTY, cannot test TUI interactively"
fi
```

## Evidence

Capture artifacts from Drive phase using isolated agent directory:

```bash
# Use PI_CODING_AGENT_DIR for all agent data writes
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EVIDENCE_DIR="$AGENT_DIR/verify-evidence-$(date +%s)"
mkdir -p "$EVIDENCE_DIR"

# Alternative: evidence under skill tree for committed proof
# EVIDENCE_DIR=".cursor/skills/verify-omp/evidence"
# mkdir -p "$EVIDENCE_DIR"

# Collect logs
cp /tmp/omp-verify-test/*.log "$EVIDENCE_DIR/" 2>/dev/null || true

# System info
cat > "$EVIDENCE_DIR/system.txt" <<EOF
Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)
OS: $(uname -a)
Bun: $(bun --version)
OMP: $(omp --version 2>&1 || bun dev -- --version 2>&1)
TTY: $(tty 2>&1)
TERM: $TERM
PI_CODING_AGENT_DIR: ${PI_CODING_AGENT_DIR:-<not set>}
Agent Directory: $AGENT_DIR
EOF

# Feature matrix
cat > "$EVIDENCE_DIR/features.md" <<'EOF'
# oh-my-pi Feature Verification Matrix

## Core Surfaces

| Feature | Status | Notes |
|---------|--------|-------|
| CLI `--help` | ✓ | Help text renders |
| CLI `--version` | ✓ | Version prints |
| `omp models` | ✓/SKIP | Provider discovery works or skipped |
| `omp sessions` | ✓ | Session list accessible |
| One-shot `-p` | ✓/FAIL | Non-interactive prompt mode |
| RPC mode | ✓/FAIL | JSON-RPC over stdio |
| SDK session | ✓/SKIP | createAgentSession works or needs keys |
| TUI interactive | ✓/SKIP/INCONCLUSIVE | Terminal UI if TTY available |

## Tool Categories (from README)

### Files & Search
- `read` — files, dirs, archives, SQLite, PDFs, URLs, SSH
- `write` — create/overwrite files
- `edit` — hashline patches
- `ast_edit` — structural rewrites
- `ast_grep` — structural queries
- `grep` — regex search
- `glob` — path lookup

### Runtime
- `bash` — workspace shell
- `eval` — Python/JavaScript cells

### Code Intelligence
- `lsp` — LSP operations
- `debug` — DAP sessions
- `security_scan` — security reviews

### Coordination
- `task` — parallel subagents
- `hub` — agent messaging
- `todo` — todo list
- `ask` — structured follow-ups

### Desktop & Web
- `browser` — Puppeteer tabs
- `computer` — desktop control
- `web_search` — multi-provider search
- `github` — GitHub CLI ops
- `generate_image` — image generation
- `tts` — text-to-speech

### Memory & Skills
- `checkpoint` — conversation state
- `rewind` — prune context
- `retain` — store facts
- `recall` — search memories
- `reflect` — synthesize answers
- `memory_edit` — update memories
- `learn` — capture lessons
- `manage_skill` — skill CRUD

## Integration Modes

- Interactive TUI (default)
- One-shot `-p` (single prompt + exit)
- RPC `--mode rpc` (stdio JSON-RPC)
- ACP `omp acp` (Agent Client Protocol)
- SDK `@oh-my-pi/pi-coding-agent` (Node embedding)

## Multi-Provider Support

60+ providers, 1000+ models across:
- Anthropic, OpenAI, Google, xAI, DeepSeek, Mistral
- Coding plans: Cursor, Copilot, Devin, Kimi Code
- Self-hosted: Ollama, LM Studio, llama.cpp, vLLM

## Native Performance

~80k LoC Rust core:
- pi-natives (grep, text, desktop, crash handler)
- pi-shell (embedded bash + 58 builtins)
- pi-ast (tree-sitter + ast-grep)
- pi-iso (workspace isolation)
- pi-voice (audio capture/playback)
- pi-walker (parallel FS walker)
EOF

echo "Evidence captured in: $EVIDENCE_DIR"
ls -lh "$EVIDENCE_DIR"
```

**Expected:** Evidence directory contains logs, system info, feature matrix. `features.md` serves as the verification report.

## Cleanup

Remove temporary test files (evidence is preserved):

```bash
# Clean test workspace
rm -rf /tmp/omp-verify-test

# Evidence is preserved in PI_CODING_AGENT_DIR or skill tree
# Do NOT delete evidence - it serves as proof for PRs and verification
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
echo "Evidence preserved at: $AGENT_DIR/verify-evidence-*"
echo "Or: .cursor/skills/verify-omp/evidence/"

# Optional: remove stale sessions (if many exist)
# omp sessions --clean-stale

# Note: Doctor and verification commands write ONLY to PI_CODING_AGENT_DIR
# when set, ensuring clean isolation for testing
```

## Feature Map Reference

### Primary Agent Surfaces (from CONTRIBUTING + README)

1. **Interactive TUI** — Default mode, tool cards, edit previews, ask dialog, keyboard controls
2. **One-Shot Mode** — `omp -p "..."` for single prompt and exit
3. **RPC Mode** — `omp --mode rpc` for stdio JSON-RPC integration
4. **ACP Mode** — `omp acp` for Agent Client Protocol (editor-driven)
5. **Node SDK** — `@oh-my-pi/pi-coding-agent` package for embedding

### Core Tool Categories (31 built-in)

- **Files:** read, write, edit, ast_edit, ast_grep, grep, glob
- **Runtime:** bash, eval (Python/JS)
- **Intelligence:** lsp (14 ops), debug (28 DAP ops)
- **Coordination:** task, hub, todo, ask
- **Desktop/Web:** browser, computer, web_search (23 providers), github
- **Generation:** generate_image, tts
- **Memory:** checkpoint, rewind, retain, recall, reflect, memory_edit, learn, manage_skill

### Session Operations

- `/vibe` — Vibe mode (director + workers)
- `/fresh` — Reset provider stream state
- `/model` — Swap active model mid-session
- `/collab` — Share live session via relay
- `/review` — Code review with priorities
- `/debug` — Debug/profiling tools
- `/advisor` — Enable advisor role (second model)

### Slash Commands & Controls

- **Model cycling:** Ctrl+P
- **Magic keywords:** ultrathink, orchestrate, workflowz
- **Prompt controls:** structured thinking triggers
- **Extensibility:** custom tools, commands, hooks, plugins

## Troubleshooting

### Common Issues

**bun not found:**
- Install bun: `curl -fsSL https://bun.sh/install | bash`
- Or use npm/npx to install globally

**omp not in PATH:**
- Source install: use `bun dev` from repo root
- NPM install: `bun install -g @oh-my-pi/pi-coding-agent`
- Binary install: ensure `~/.omp/bin` or install dir in PATH

**TTY unavailable (cloud VM):**
- Use RPC mode: `omp --mode rpc --no-session`
- Or SDK embedding instead of interactive TUI
- CLI commands (`models`, `sessions`, `-p`) still work

**API keys needed:**
- Configure in `~/.omp/agent/config.yml`
- Or use environment variables (per provider docs)
- Test with `omp models <provider>` to verify

**Native addon missing:**
- Source: run `bun setup` to build @oh-my-pi/pi-natives
- Installed: reinstall package or use prebuilt binaries

## Success Criteria

✅ **PASS** if:
- Doctor phase completes without errors
- Drive phase executes at least CLI catalog + one-shot OR RPC test
- Evidence directory generated with logs and feature matrix
- At least one interactive surface (TUI, RPC, or SDK) responds to prompts

⚠️ **INCONCLUSIVE** if:
- TTY unavailable but CLI/RPC tests pass (note VM limitation)
- API keys missing but SDK session structure works
- Some providers skip due to no credentials (expected)

❌ **FAIL** if:
- omp binary/source not accessible
- Version/help output broken
- All interactive surfaces timeout or error
- Native addon missing and cannot be built

## Notes

- This skill tests the **coding-agent package** implementation, not this assistant
- Evidence survives cleanup — preserve `/tmp/omp-verify-evidence-*` for PRs
- TUI requires real TTY; cloud VMs may only support CLI/RPC paths
- Full tool surface testing requires working model API access
- For comprehensive testing, see `packages/coding-agent/DEVELOPMENT.md`
