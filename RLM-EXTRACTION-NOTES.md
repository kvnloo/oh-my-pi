RLM extraction from OMP core (per architecture plan):
- Move src/rlm/* → rlm-extension/ (not in this worktree; separate repo/package)
- RLM extension registers: /rlm query, /rlm evidence, /context RLM sections
- OMP core exposes generic primitives already added by core/live-runtime + existing hooks:
  context.observe(), session.onEvent(), tool.register(), decision.registerProvider()
- Core changes required for RLM (separate core/* threads, NOT this branch):
  core/context-hooks, core/decision-provider, core/rpc-hooks
- Load sequence: /runtime reload loads rlm-extension; /runtime reload-all broadcasts
