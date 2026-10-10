# Full coding-agent package typecheck: PASS

This is the first actual full-package typecheck on the exact published formatting optimization. The earlier formatting receipt retained an unrun HOLD because another coding-agent worktree had hit a resource limit. Those earlier SIGKILLs were on runner identity, not this formatting tree; no prior formatting failure is claimed.

## Exact source and command

- Published formatting commit: `eabb97c9274f8d0e4354989538442d2d9d7aa1bb`.
- Local tested commit: `dbd77a3e510b69a5c410066183c5f0af3b24cacb`.
- Both complete Git trees: `debc8d98f6b29e4e67c640a80107d7cf74d332ff`.
- Helper SHA-256: `0af08fc0cd0eb6adab9385e7b336772d3a0c0a2b18033f9706ddee84bfb99c3c`.
- Linux, Bun 1.4.2, existing workspace dependencies.
- From `packages/coding-agent`: `GOMAXPROCS=2 GOMEMLIMIT=2GiB bun run check:types`.
- Actual package script: `tsgo -p tsconfig.json --noEmit`, with no narrowed project, source selection or configuration override.

**Exit 0**, 45.565921 seconds, 2026-10-10 05:13:31–05:14:16 UTC. The complete output is `output.txt`; source, exit, timestamp and resource evidence are in the adjacent JSON files. Original before/after manifests were identical, including source bytes, modes and ownership, and the owner worktree stayed clean. Every recorded file hash was independently checked against the published Git object before this receipt update.

## Resource context

Material cleanup of inactive temporary/generated caches made substantially more host RAM available before a quiet, bounded validation window. This changed the validation resources, not the source or installed dependencies. Initial available RAM was 6,088,788 KiB; minimum observed availability was 1,639,276 KiB. Peak sampled process-group RSS was 4,224,452 KiB and `wait4` maximum child RSS was 4,246,732 KiB. `GOMEMLIMIT=2GiB` is a Go soft target, not a hard total-RSS ceiling.

The monitor allowed 240 seconds and stopped work if host availability fell below 600 MiB. Neither stop fired. These resources describe the typecheck, not memory improvements from the optimization. The performance corpus, measurements and all source/carrier blobs remain unchanged.

## Portability and historical evidence

`result.json` uses a repository-relative working directory. Public before/after manifests omit numeric local UID/GID while retaining all file hashes and modes. `resources.jsonl` and `output.txt` are byte-identical to the verifier originals. `original-sha256.json` records the original receipt/coordinator hashes. No original receipt or prior log was deleted; the previous unrun formatting HOLD is preserved in this commit's ancestry.

The portable coordinator only replaces machine-specific checkout/output/Bun-path selection with explicit paths and the caller's PATH; its command and monitoring logic match the original. The portable wrapper also returns the child's shell-equivalent exit code, rather than requiring the caller to inspect result.json. It requires Linux, Python 3, Git and Bun in PATH, the exact tested snapshot above, and already installed normal workspace dependencies. Give it a nonexisting output directory:

```sh
python3 validation/format-options/full-package-types-20261010/reproduce.py \
  /path/to/checkout-of-eabb97c9274f8d0e4354989538442d2d9d7aa1bb \
  /path/to/new-output-directory
```

Alternatively, run the package command above directly from that exact checkout. This receipt update did not rerun the typecheck or benchmarks.

## Remaining limits

The coding-agent full-package typecheck HOLD is closed for the exact formatting tree. Aggregate root/full-workspace checks, the full native-backed/Rust suite, Windows execution and hosted CI remain unrun/unverified. This is not a merge-readiness claim. The narrow carrier is the same optimization with byte-identical helper/test/changelog blobs; it was not separately typechecked.
