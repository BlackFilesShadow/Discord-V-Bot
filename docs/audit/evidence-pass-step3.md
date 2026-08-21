# Step 3 — Etappen 1–26 Evidence-Pass

**Freeze SHA:** `48bbcfface38068bc71ad7bcc5c1dd87616da514` (`48bbcffa`)  
**Branch:** `main` = `origin/main` (re-verified)  
**Mode:** audit only — application code/tests untouched  
**Updated artifacts:** `stage-matrix-1-67.json` (stages 1–26), `findings-step3.json`, this report  
**Companion:** Step 2 `structure-coupling-map.json` for process/mount chains

---

## Mapping caveat (mandatory)

| Range | Nature |
|-------|--------|
| **1–22** | **Audit-constructed** from Issue #73 labels AI-1…AI-20 + Ops-1 + Mobile (not historic `Stage N/67` PR numbers). |
| **23** | Explicit **Etappe 23** in Issue #73 + `docs/dashboard-surface-inventory.json`. |
| **24–26** | PR/docs `Stage 24–26/67` button/switch/CRUD matrices; Issue #73 HOCH boxes largely **unchecked**. |

Checkbox `[x]` ≠ VERIFIED. Evidence hierarchy: runtime wiring > architecture gates > unit mocks > PR/#73 text.

DB-1…4 / Leave / Economy overlays are **not** renumbered into 1–26; they remain Step-1 overlays (still PENDING as named overlays; deep pass later).

---

## Scoreboard 1–26 @ freeze

| Stage | Issue label | Status | One-line verdict |
|------:|-------------|--------|------------------|
| 1 | AI-1 | **VERIFIED** | `modelRegistry` → `config` boot defaults/legacy |
| 2 | Ops-1 | **PARTIAL** | Docker/deploy present; bare-metal smoke not re-run |
| 3 | AI-2 | **VERIFIED** | `installAiProviderRequestCompatibility()` in `index.ts` |
| 4 | AI-3 | **VERIFIED** | Memory R/W/clear require explicit `guildId` |
| 5 | AI-4 | **VERIFIED** | DayZ technical path via `nitradoHelp` in `aiHandler` |
| 6 | Mobile | **PARTIAL** | 44px CSS yes; inventory shell-only mobile debt |
| 7 | AI-5 | **VERIFIED** | No legacy scope inference; callsites pass scope |
| 8 | AI-6 | **VERIFIED** | `wrapUntrustedContext` on context bundle |
| 9 | AI-7 | **VERIFIED** | Task profile + capability filter in provider order |
| 10 | AI-8 | **VERIFIED** | HTTP classify + cooldown + multi-provider fallback |
| 11 | AI-9 | **VERIFIED** | `clampBlock`/`clampHistory` on answer assembly |
| 12 | AI-10 | **VERIFIED** | Hybrid RAG + scope resolver; embeddings best-effort |
| 13 | AI-11 | **VERIFIED** | Provenance freshness EXPIRED filtered |
| 14 | AI-12 | **VERIFIED** | Knowledge manifest/hash/platform |
| 15 | AI-13 | **VERIFIED** | General catalog blocked on live-intent |
| 16 | AI-14 | **VERIFIED** | Mirror snapshot → live index (index fail warn-only) |
| 17 | AI-15 | **VERIFIED** | Deterministic XML/JSON validation pre-index |
| 18 | AI-16 | **VERIFIED** | Guard attach + preflight + post-answer validate |
| 19 | AI-17 | **VERIFIED** | Recognition scoped; not authorization |
| 20 | AI-18 | **FAILED** | Tool layer **library-only** (F-S2-01 / F-S3-04) |
| 21 | AI-19 | **VERIFIED** | Offline golden eval suite (not live LLM) |
| 22 | AI-20 | **VERIFIED** | Provider/retrieval/source metrics wired |
| 23 | Etappe 23 | **PARTIAL** | 57/16/43 inventory; stale SHA; partial/shell-only |
| 24 | Buttons | **PARTIAL** | 351-button AST matrix; stale SHA; no full E2E |
| 25 | Switches | **PARTIAL** | Reachable Switch AST + a11y; #73 open |
| 26 | CRUD | **PARTIAL** | JSON contracts; SHA hard-pin stale; #73 open |

**Counts (full 1–67 matrix after Step 3):** VERIFIED=19 · PARTIAL=6 · FAILED=1 · PENDING=41 · BLOCKED=0  

**PRODUCTION READY: NO** · FINAL SCORE: not computed (stages 27–67 pending)

---

## A–O method (how applied)

For each stage: goal from #73 → locate runtime code → couplings → positive path → negative/fail-closed → race/scope notes (short where thin) → persistence/restart if relevant → tests vs contract → mock-only risk → later-regression risk → cross-stage links. Full prose only for high-risk items (AI-18, RAG/live, dashboard 23–26).

---

## AI stack runtime chain (stages 1,3–5,7–22)

```
index.ts
  installAiProviderRequestCompatibility()
  … clientReady → startAiBackgroundLoops (best-effort guild/RAG/memory/translated)
messageCreate | /ai ask
  buildServerUserContext → blocks + attachHallucinationGuardReference
  answerQuestion → memory scope, catalog, budget, providers, guard validate
nitrado mirror snapshot OK/PARTIAL
  indexNitradoSnapshotKnowledge → validateDayzKnowledgeSet → guildKnowledge LIVE
```

**Not on chain:** `AiToolExecutor` (stage 20 FAILED).

### Per-stage evidence notes (condensed)

**1 VERIFIED** — `src/modules/ai/modelRegistry.ts` single defaults map; `config` imports `parseAiProvider`/`resolveAiModel`. Tests: `tests/modules/aiModelRegistry.test.ts`.

**2 PARTIAL** — `Dockerfile` node:22 multi-stage, `CMD migrate deploy && node dist/src/index.js`; `deploy/{setup,bot,smoke,backup,update}.sh`. No freeze-SHA bare-metal execution this step (F-S3-01).

**3 VERIFIED** — `src/index.ts` calls `installAiProviderRequestCompatibility()` before login. Tests: `aiProviderRequestCompatibility`.

**4+7 VERIFIED** — `conversationMemory.ts` requires `guildId: string|null` on record/get/clear; TTL 24h, cap 10. `aiHandler` dynamic import passes `opts.guildId ?? null`. Cleanup loop from `runtime.ts`. Tests: `conversationMemoryScope` (mocked prisma + source gate).

**5 VERIFIED** — `aiHandler` imports `lookupNitradoHelp` / `validateDayzTechnicalAnswer` / fallbacks. Tests: `nitradoHelp`.

**6 PARTIAL** — CSS `@media (pointer: coarse)` min 44px (`index.css`, `theme.css`). Inventory mobile: 28 verified / 28 shell-only. #73 authenticated mobile matrix open (F-S3-02).

**8 VERIFIED** — Context serialized as `AI_CONTEXT_BUNDLE_V2` inside `wrapUntrustedContext`. Tests: `aiContextInjectionFirewall`.

**9–10 VERIFIED** — `inferAiTaskProfile` + `providerSupportsTask` + `getRankedProviders`; failures via `classifyProviderHttpStatus` / `markProviderUnavailable` / cooldown. Tests: capabilities, fallback matrix, circuit restart, cooldown.

**11 VERIFIED** — `clampBlock`/`clampHistory` in answer message build. Tests: `promptBudget`.

**12 VERIFIED** — `findRelevantKnowledge` hybrid weights + scope filter; `resolveRuntimeKnowledgeScope` multi-server fail-closed. Embeddings init best-effort (F-S2-04). Tests: scoped retrieval, embeddings, knowledgeScope.

**13 VERIFIED** — EXPIRED provenance dropped before score; `recordAiKnowledgeSource`. Tests: `knowledgeProvenance`.

**14–15 VERIFIED** — Manifest validation; `answerDayz129CatalogQuestion` returns null if live-intent. Live path separate modules.

**16 VERIFIED + MED note** — `snapshotService` → `indexNitradoSnapshotKnowledge` with binding/lease. Index errors warn-only (F-S3-03).

**17 VERIFIED** — `validateDayzKnowledgeSet` used inside live index; unit + golden VALIDATION cases.

**18 VERIFIED** — Guard built in `contextBuilder`; `attachHallucinationGuardReference`; `answerQuestion` preflight + `validateLiveServerAnswer`. Callers: `messageCreate`, `commands/user/ai.ts`.

**19 VERIFIED** — `resolveVerifiedGameIdentityRecognition` only with resolved gameserver scope; comments/tests: not authz.

**20 FAILED** — `toolLayer.ts` + `aiToolStepUp.ts` complete API; **only** `tests/ai/toolLayer.test.ts` / `tests/security/aiToolStepUp.test.ts` construct executor. No prod registration. Issue #73 AI-18 `[x]` is overclaim (F-S3-04, F-S2-01).

**21 VERIFIED (offline contract)** — `runGoldenDayzEvaluation` offline; F-S3-05 notes not live LLM.

**22 VERIFIED** — `providerStats.recordCall` → attempt/fallback metrics; contextBuilder retrieval metrics. Tests: `aiObservability`.

---

## Dashboard stages 23–26

### 23 PARTIAL (explicit Etappe 23)

| Claim | At freeze |
|-------|-----------|
| 57 UI surfaces | JSON length 57; arch test enforces |
| 16 server mounts / 43 v2 mounts | Present in inventory; Step 2 confirmed v2 mounts in `v2.ts` |
| inventoriedMainSha | **`b98e2cf…` ≠ freeze `48bbcffa`** (F-S3-06) |
| tests.status | verified 28 / partial 29 |
| mobile.status | verified 28 / shell-only 28 / partial 1 (F-S3-07) |
| Gate type | Architecture: App routes + id set + field contract — **not** full authenticated E2E |
| Issue #73 | Inventory item `[x]`; HOCH full matrix still `[ ]` |

### 24 PARTIAL

- `docs/dashboard-button-matrix.json`: **351** buttons, reachable from `App.tsx`, kind/loading contracts.
- `inventoriedMainSha=3daf103…` stale.
- Gate: TypeScript AST walk — static completeness, not click/API proof.
- Issue #73 buttons unchecked.

### 25 PARTIAL

- Live AST inventory of reachable `<Switch>` vs reviewed surface allowlist; shared `Switch` a11y (`role=switch`, `aria-checked`, 44px via theme).
- Doc is markdown without freeze SHA.
- Issue #73 switches unchecked.

### 26 PARTIAL

- `persistentCrud=20`, `ephemeral=13`, `operationalActions=6`.
- `basedOnMainSha=d71b21e…` **hard-pinned** in `dashboardCrudMatrixArchitecture.test.ts`.
- Evidence path existence checks ≠ runtime IDOR/race (stages 36–38).

---

## Mock-only / gate-drift risks

| Area | Risk |
|------|------|
| Memory scope tests | Mocked prisma + string gates on aiHandler — **backed by real API signatures** |
| Dashboard 23–26 | Architecture/static primary; product AuthZ/E2E incomplete |
| AI tool tests | High quality units **without** production consumer |
| CRUD SHA pin | Gate freezes **old** SHA → green while HEAD drifts |
| Local `test:ci` vs CI | F-PRE-01 still open; Step 3 did not re-run full suites |

---

## Cross-stage / later regression

- Security/AuthZ stages 36–45 can invalidate 23–26 “partial verified” surfaces.
- Leave/Nitrado later stages interact with AI-14 binding fence (already coupled).
- Stage 20 gap blocks any future “AI mutates Nitrado via tools” narrative.
- Best-effort AI runtime (F-S2-04) softens 12/16 operational guarantees.

---

## Findings raised this step

See `docs/audit/findings-step3.json`: **F-S3-01…F-S3-09** (plus inherited F-S2-01, F-PRE-06/11).

Highest priority for fix wave:

1. **F-S3-04 / F-S2-01** — AI tool layer prod wiring or tracker reopen  
2. **F-S3-06 / F-S3-07** — Re-inventory dashboard at freeze SHA; reduce shell-only  
3. **F-S3-02** — Authenticated mobile matrix  

---

## Commands / shortcuts used

```powershell
git rev-parse HEAD; git status -sb
# inventory aggregates
(Get-Content docs/dashboard-surface-inventory.json | ConvertFrom-Json)
# greps (agent tools): AiToolExecutor, buildServerUserContext, liveServerKnowledge, recordAiProvider
# targeted opens: aiHandler, contextBuilder, conversationMemory, toolLayer, runtime, snapshotService, dashboard*Architecture tests
powershell -File docs/audit/_step3_update_matrix.ps1
```

**High-ROI for Step 4 (27–67):**

- Trust `docs/audit/structure-coupling-map.json` mounts; don’t re-walk v2.
- Treat any `docs/dashboard-*-matrix*.json` `*MainSha` ≠ freeze as automatic PARTIAL.
- `rg AiToolExecutor src` must stay empty outside toolLayer until fixed.
- Architecture dashboard tests ≠ authenticated E2E (Issue #73 open boxes).

---

## Handoff → Step 4

- Stages **27–67** still PENDING.  
- Do **not** promote 23–26 without freeze-SHA re-inventory + E2E.  
- Stage **20** remains hard FAILED until tool wiring.  
- Keep PRODUCTION READY = NO.
