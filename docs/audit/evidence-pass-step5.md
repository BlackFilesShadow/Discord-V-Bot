# Step 5 — CLI Full Verification + Test-/Security-Audit

**Freeze SHA:** `48bbcfface38068bc71ad7bcc5c1dd87616da514`  
**Branch:** `main` = `origin/main` (clean app tree; audit artifacts untracked)  
**Date (local):** 2026-08-21  
**App code/tests:** unchanged (audit artifacts + runner only)

## 1. Commands executed (exact)

| Step | Command | Exit | Notes |
|------|---------|------|-------|
| SHA | `git rev-parse HEAD` / `origin/main` | 0 | both `48bbcffa…` |
| Prisma generate | `npx prisma generate` | 0 | Client v7.9.1 |
| Prisma validate | `npx prisma validate` | 0 | schemas valid |
| Lint | `npm run lint:all` | 0 | 0 errors / 13 UI warnings |
| Build | `npm run build` | 0 | UI+`tsc`; index ~775 kB |
| DB consistency | `npm run db:consistency` | **3** | no Postgres |
| Root audit critical | `npm audit --audit-level=critical` | 0 | 0 critical |
| Root audit high | `npm audit --audit-level=high` | **1** | 3 high `deepmerge-ts` |
| Root audit prod high | `npm audit --omit=dev --audit-level=high` | **1** | same chain via prisma |
| UI prod high | `dashboard-ui`: `npm audit --omit=dev --audit-level=high` | 0 | 0 vulns |
| UI critical | `dashboard-ui`: `npm audit --audit-level=critical` | 0 | |
| Jest (partial env) | `npx jest --coverage --maxWorkers=4 --testTimeout=60000 --ci --json --outputFile=docs/audit/cli-evidence/jest-results-latest.json` + `DATABASE_URL`,`DISCORD_TOKEN`,`DISCORD_CLIENT_ID` | **1** | **23** fail / 415 pass suites |
| Jest (full CI env, no PG) | same + `DISCORD_CLIENT_SECRET`,`BOT_OWNER_ID`,`ENCRYPTION_KEY`,`SESSION_SECRET`,`DASHBOARD_URL` → `jest-results-ci-env.json` | **1** | **11** fail / 427 pass suites; **16** fail / 2834 pass tests; ~11s |
| GH CI | `gh run view 32525882200 --json …` | 0 | **success** all jobs |
| GH E2E | `gh run view 32525882181 --json …` | 0 | **success** Playwright Smoke |

**Reusable runner:** `docs/audit/run-cli-verification.ps1`  
**Evidence dir:** `docs/audit/cli-evidence/`

### CI env block mirrored for local Jest (from `.github/workflows/ci.yml`)

```
DATABASE_URL=postgresql://test:test@localhost:5432/discord_v_bot_test
DISCORD_TOKEN=test-token
DISCORD_CLIENT_ID=test-client-id
DISCORD_CLIENT_SECRET=test-secret
BOT_OWNER_ID=123456789012345678
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
SESSION_SECRET=test-session-secret
DASHBOARD_URL=http://localhost:3000
```

Local host: **no** listener on `localhost:5432`, **no** `.env` / `.env.test`.

## 2. GitHub gates (same SHA) — finalized

### CI/CD Pipeline run `32525882200`

| Job | Conclusion | Notable steps |
|-----|------------|---------------|
| Security Audit | **success** | critical block OK; high report-only; dashboard prod high OK; SBOM generate+upload **success** |
| Lint & Build | **success** | prisma generate/validate, lint:all, tsc |
| Tests | **success** | migrate deploy/status, **db:consistency**, **db:lifecycle**, **test:ci**; Diagnose open handles **skipped** (OK) |
| Docker Build | **success** | |
| Publish Main CI Gate Status | **success** | |

URL: https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882200  
Artifact JSON: `docs/audit/cli-evidence/gh-ci-32525882200.json`

### E2E Playwright run `32525882181`

| Job | Conclusion |
|-----|------------|
| Playwright Smoke | **success** (`Run E2E=success`) |

Skipped non-failure: browser install on cache hit; upload report on failure.  
URL: https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882181  
Artifact: `docs/audit/cli-evidence/gh-e2e-32525882181.json`

**Verdict:** Pflichtjobs on freeze SHA are green (no failed/pending required jobs). Conditional skips only.

## 3. Jest failure root-cause matrix

### 3a Partial env (23 suites)

Includes all of 3b plus **12 load-time** failures:

`linkRewards`, `getAccountOrZero`, `economyStructuredLedger`, `bankInterest`, `economyLottery`, `consoleLinkingCommands`, `translatedPostImage`, `translatedPostImageLimit`, `botInfoConsistency`, `privilegedCommandFlow`, `privilegedCommandDefinitions`, `nitradoModerationCommandSchema`

**Class:** `env_gated` — `src/config.ts` `requireEnv` (`DISCORD_CLIENT_SECRET` then `ENCRYPTION_KEY`, …).  
**Recovered** after full CI env injection → suite count 23→11.

### 3b Full CI env, no Postgres (11 suites residual)

| Suite | Class | Product bug? | Detail |
|-------|-------|--------------|--------|
| `interactionDispatcherProduction` | gate_drift_platform_CRLF | No (local false fail) | section end marker `/**\n * Giveaway-Button` not found; file is CRLF; `togglePollVote` **present** |
| `dashboardPermissionIntegrityArchitecture` | gate_drift_platform_CRLF | No* | string index -1 |
| `leaveRejoinLifecycleGate` | gate_drift_platform_CRLF | No* | functionSlice end -1 / LF patterns |
| `nitradoWhitelistIntentGate` | gate_drift_platform_CRLF | No* | |
| `nitradoTokenValidationLockGate` | gate_drift_platform_CRLF | No* | expects `finally {\n    await lock.release();\n  }`; source has CRLF equivalent in `tokenValidationCron.ts` |
| `nitradoAdmBindingFenceGate` | gate_drift_platform_CRLF | No* | SQL/string LF shapes |
| `nitradoConfigLockConnectCleanupGate` | gate_drift_platform_CRLF | No* | `await client.end(); return null;` LF form |
| `economyTwoServerIsolationIntegration` | env_gated_no_postgres | No | Prisma connect/deleteMany fail |
| `nitradoValidationHealthIntegration` | env_gated_no_postgres | No | |
| `idempotencyMigrationRepair` | env_gated_no_postgres | No | `AggregateError` connect |
| `metricsBootstrap` | env_platform_bash_path | No (script OK under Git Bash) | `spawnSync('bash')` → WSL stub status 1; `Git\bin\bash.exe` status 0 |

\* “No” = not proven as missing production code from local evidence; **CI string gates pass on LF**. Semantic adequacy of gates remains architecture-test limitation (Step 4).

### 3c Primary divergence root cause (F-S5-01)

```
Windows checkout (core.autocrlf=true, no .gitattributes)
  → CRLF in src/**/*.ts
  → architecture tests use exact "\n" anchors
  → local FAIL / Ubuntu CI PASS
+ no Postgres → integration + db:* local FAIL / CI PASS
+ missing env → extra suite load FAIL
+ bash PATH → metricsBootstrap local FAIL / CI PASS
```

**This overturns naive “21 product regressions on main”** as the sole explanation of local red vs CI green. Residual: gates are still brittle; high CVEs remain real.

## 4. Security / dependency

| Check | Result |
|-------|--------|
| Root critical | **0** / pass |
| Root high | **3** (`deepmerge-ts` via `prisma` / `@prisma/config`) GHSA-ggr8-5vv4-36mx |
| Force fix | Would downgrade to prisma@6.12.0 — **rejected** as fix path |
| Dashboard prod high | **0** |
| CI policy | critical blocking; high report-only — matches observed CI success with local high exit 1 |
| Classification | **Open risk / exception candidate**, not silent zero |

## 5. db:consistency / lifecycle

| Check | Local | CI same SHA |
|-------|-------|-------------|
| `db:consistency` | FAIL exit 3, no PG | SUCCESS |
| `db:lifecycle` | not green on Windows without bash+PG tooling | SUCCESS |

**Class:** env_gated for local; **not** used to claim scanner product breakage against freeze SHA.

## 6. Dashboard

- `lint:all` includes UI (warnings only).
- Root `npm run build` builds UI successfully.
- Prod audit high clean.
- Authenticated full E2E matrix still **not** claimed VERIFIED (Step 4 / #73); GH Playwright is smoke-level success only.

## 7. Scoreboard impact for Step 6

| Signal | Status |
|--------|--------|
| Freeze SHA pinned | YES |
| Local lint/build/prisma | GREEN |
| Local test:ci full parity | **RED** (explained) |
| Local db:consistency | **RED** (env) |
| Root high audit | **RED** (3 high) |
| GH CI + Playwright same SHA | **GREEN** |
| PRODUCTION READY | **NO** |
| FINAL SCORE 100/100 | **NOT** earned |

## 8. Artifacts index

| Path | Content |
|------|---------|
| `docs/audit/run-cli-verification.ps1` | Reusable CLI runner + failed-test JSON capture |
| `docs/audit/cli-evidence/summary-latest.json` | Machine summary |
| `docs/audit/cli-evidence/jest-results-latest.json` | Partial-env Jest JSON |
| `docs/audit/cli-evidence/jest-results-ci-env.json` | Full-env Jest JSON |
| `docs/audit/cli-evidence/failed-tests-latest.json` | Parsed failures (partial) |
| `docs/audit/cli-evidence/failed-tests-ci-env.json` | Parsed failures (full env) |
| `docs/audit/cli-evidence/jest-ci-console.log` / `jest-ci-env-full.log` | Console tails |
| `docs/audit/cli-evidence/root-audit-full.json` | npm audit JSON |
| `docs/audit/cli-evidence/gh-ci-32525882200.json` | GH CI job/step map |
| `docs/audit/cli-evidence/gh-e2e-32525882181.json` | GH E2E map |
| `docs/audit/findings-step5.json` | F-S5-01…09 |
| `docs/audit/evidence-pass-step5.md` | This report |

## 9. Handoff to Step 6

- Aggregate findings: seed + step2–5; keep stage **20 FAILED**, **67 BLOCKED**, 27–66 **PARTIAL** unless Step 6 re-scores with new rules.
- Do **not** flip 63–66 to VERIFIED solely on GH green while F-S5-01/03 and #73 Abschluss remain open.
- Fix wave (future, not this step): CRLF-safe architecture helpers, local DB compose, jest setup env, prisma/deepmerge tracking — **no** test deletion/weakening.

### Discoveries (execution)

- Full CI-env Jest ~11s with `--maxWorkers=4 --coverage=false` on warm machine.
- `core.autocrlf=true` + no `.gitattributes` is the smoking gun for architecture false fails.
- Default `bash` on PATH can be WSL stub; prefer `Git\bin\bash.exe` for script tests on Windows.
- GH: `gh run view 32525882200` / `32525882181` sufficient for job-level freeze evidence.
