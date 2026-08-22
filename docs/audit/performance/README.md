# Performance evidence (Stages 46–52)

SHA-bound measurement artifacts must live here.

## Wave E probe (Stages 46–48)

```bash
npm run perf:baselines-46-48
# or: RUNTIME_BASELINE_MS=1500 node scripts/runtime-baselines-46-48.mjs
```

Writes:

```
docs/audit/performance/<GIT_SHA>/
  46-runtime-baseline.json   # RAM, heap, CPU, event loop, handles
  47-data-plane.json         # pool/tx contracts + optional live DB/Redis
  48-external-deps.json      # AI/Nitrado timeout/retry/circuit contracts
  wave-e-envelope.json
docs/audit/performance/LATEST_WAVE_E.json   # pointer only
```

Optional live data-plane:

```bash
DATABASE_URL=... REDIS_URL=... npm run perf:baselines-46-48
```

## Current honesty

| Stage | What is measured | Residual |
|------|------------------|----------|
| 46 | Real in-process RSS/heap/CPU/ELD/handles + metrics module pins | Not full bot+gateway production RSS |
| 47 | Prisma pool/tx contracts, Redis dep, NitradoJob worker surface; live ping if env set | Pool saturation / pg_stat_statements need live DB |
| 48 | Source contracts for AI/Nitrado timeouts, 429, circuit, metrics | Live provider RTT needs credentials |
| 49–52 | Separate load/soak/leak waves | Not claimed by Wave E |

Structural scripts that exit 0 **without** numeric samples **must not** be counted as Stage-46 VERIFIED alone. The Wave E probe always samples process metrics.

## Required layout (full 46–52 when environment available)

```
docs/audit/performance/<RELEASE_SHA>/
  46-runtime-baseline.json
  47-data-plane.json
  48-external-deps.json
  49-leak-probe.json
  50-load.json
  51-soak.json
  52-heap-tuning-notes.md
```
