# Performance evidence (Stages 46–52)

SHA-bound measurement artifacts must live here.

## Current status (honest)

**PARTIAL / infrastructure-limited on this agent host.**

Missing on the audit fix workstation:

- Docker engine (cannot start load/soak harness DB/redis containers)
- Authorized staging/production metrics endpoints
- Sustained load generators against a live bot process

## Required artifact layout (when environment available)

```
docs/audit/performance/<RELEASE_SHA>/
  46-runtime-baseline.json   # RAM, heap, CPU, GC, event loop
  47-data-plane.json         # DB pool, queries, redis, workers
  48-external-deps.json      # AI/Nitrado timeout/retry/429/5xx
  49-leak-probe.json
  50-load.json
  51-soak.json
  52-heap-tuning-notes.md
```

Structural scripts that exit 0 without measuring **must not** be counted as VERIFIED evidence.
