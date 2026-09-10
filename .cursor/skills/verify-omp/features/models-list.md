# Feature: Models Discovery

## Sub-features

- `omp models` — List all available models across providers
- `omp models <provider>` — List models for a specific provider
- `omp models --help` — Show models command usage

## How to get to it

```bash
# List all models
omp models

# List provider-specific models
omp models anthropic
omp models openai

# Show help
omp models --help
```

## Driving it with the harness

The verification harness tests model discovery:

1. Runs `omp models` and captures output to `evidence/models/list-output.txt`
2. Attempts `omp models anthropic` and captures to `evidence/models/provider-filter.txt`
3. Treats API key errors as non-fatal (warns but continues)
4. Fails hard (exit 1) only if the command itself is broken, not if API keys are missing

## Gotchas

- Model availability depends on configured API keys
- Missing keys result in empty lists or authentication errors (expected)
- Provider names are case-sensitive (e.g., `anthropic` not `Anthropic`)
- Some providers (like Ollama) require local services to be running
- Output format may vary based on terminal width and available models
