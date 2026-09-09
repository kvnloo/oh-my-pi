# Feature: Models Discovery

## User Surface

`omp models [provider]` — List available models, optionally filtered by provider.

## What It Does

- Queries available AI models across configured providers
- Displays model names, capabilities, and metadata
- Supports filtering by provider (e.g., `omp models anthropic`, `omp models openai`)
- Shows model availability based on API keys and configuration

## How to Test

```bash
# List all models
omp models

# List provider-specific models
omp models anthropic
omp models openai
omp models ollama

# Check help
omp models --help
```

## Success Criteria

- Command executes without error
- Output lists model identifiers
- Provider filtering works when specified
- Handles missing API keys gracefully (shows available vs unavailable)
- Help text displays usage information

## Evidence Path

`.cursor/skills/verify-omp/evidence/models/list-output.txt`
`.cursor/skills/verify-omp/evidence/models/provider-filter.txt`
