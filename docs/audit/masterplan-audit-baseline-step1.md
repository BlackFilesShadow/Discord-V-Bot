# Masterplan Audit — Step 1 Baseline (SHA Freeze + Matrix Skeleton)

**Generated:** 2026-08-21T21:10:00Z (local session)  
**Audit order:** Etappen 1–67 independent E2E audit  
**Canonical tracker:** [GitHub Issue #73](https://github.com/BlackFilesShadow/Discord-V-Bot/issues/73) — *Masterplan 100/100 – Produktionsreife Tracker*  
**Issue state (live query):** OPEN · 118 comments · updated 2026-08-21T20:58:32Z  
**Body snapshot file:** `.issue73-body.txt` (session artifact; encoding may show mojibake — semantic content authoritative)

---

## 1. SHA baseline (frozen for Evidence Cycle 1)

| Item | Value |
|------|--------|
| Branch | `main` (= `origin/main`) |
| Working tree | Clean tracked tree; untracked only: `.issue73-body.txt`, `.junie/` (audit session) |
| **HEAD / origin/main** | `48bbcfface38068bc71ad7bcc5c1dd87616da514` |
| Short SHA | `48bbcffa` |
| HEAD subject / time | Merge PR #238 · 2026-08-21 22:54:01 +0200 |
| `git diff --check` | Clean (no whitespace errors) |
| Merge parent chain (recent) | `#238` → `48bbcffa` · `#237` → `9dc9155` · `#235` → `e7aff90` · `#234` Stage 63 freeze |

### Commands used (re-verify)

```powershell
git fetch origin
git rev-parse HEAD
git rev-parse origin/main
git status -sb
git log -5 --oneline
git diff --check
gh issue view 73 --json number,title,state,url,updatedAt,comments
gh run list --commit 48bbcfface38068bc71ad7bcc5c1dd87616da514 --limit 20 --json databaseId,name,status,conclusion,url
gh run view 32525882200 --json conclusion,jobs
gh run view 32525882181 --json conclusion,jobs
gh pr view 238 --json number,title,state,mergedAt,mergeCommit,url
```

### GitHub gates on freeze SHA `48bbcffa` (push after #238 merge)

| Workflow | Run ID | Conclusion | Jobs |
|----------|--------|------------|------|
| CI/CD Pipeline | [32525882200](https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882200) | **success** | Security Audit, Lint & Build, Tests, Docker Build, Publish Main CI Gate Status — all **success** |
| E2E (Playwright) | [32525882181](https://github.com/BlackFilesShadow/Discord-V-Bot/actions/runs/32525882181) | **success** | Playwright Smoke — **success** |

**Note:** Preliminary plan text had Playwright `in_progress`; **recheck at Step-1 close: both main push workflows SUCCESS**. This does **not** alone satisfy Issue #73 Final Gate 2/2 or unchecked Abschluss checkboxes. Local CLI full verification still required (see seed findings).

### PR #238 claim vs tracker

- PR title: *Stage 64-65/67: Final Gate Revalidation*
- Body: empty-tree identity freeze for two independent PR gate cycles; merge only after 2/2; then Stage 66 main verify.
- Issue #73 **Abschluss** section still has unchecked: Release-SHA, Final Gate 1/2, 2/2, main+Docker+Playwright, Deploy/Live, 100/100.
- **Audit stance:** PR claim = candidate evidence only; stages 63–67 remain **not VERIFIED** until code+CLI+#73 rules satisfied on this SHA.

---

## 2. Numbering map: Audit Etappen 1–67 ↔ Issue #73 ↔ PRs/docs

### Mapping rules

1. **Canonical audit IDs** are integers **1–67** (this engagement). Do not renumber history.
2. Issue #73 primarily uses **domain labels** (`AI-*`, `DB-*`, `Leave-*`, `Economy-*`, `Dashboard-*`, `Nitrado-*`) plus free-text Abschluss bullets — **not** a full 1–67 checkbox list.
3. **Stages 23–63** are explicitly numbered in merged PR titles (`Stage N/67` / `Etappe N/67`) and `docs/*-matrix.json` `"stage": N`.
4. **Stages 64–67** are gate/release/deploy phases (PR #235/#237/#238 narrative); no single matrix JSON for 64–67 equivalent to 23–63.
5. **Stages 1–22** = pre–surface-inventory foundation. Issue #73 marks many as `[x]` under *Bereits abgeschlossen* / domain HOCH sections. Audit still treats them as **PENDING evidence** at HEAD (checkbox ≠ VERIFIED).
6. Evidence hierarchy: runtime code + couplings > architecture/gate tests > unit mocks > PR text > #73 `[x]`.

### Issue #73 checkbox inventory (body snapshot)

#### Checked `[x]` (claims only — not audit VERIFIED)

| Block | Items (labels / summary) | Linked PRs (from body) |
|-------|--------------------------|-------------------------|
| Bereits abgeschlossen / AI | AI-1…AI-20, Ops-1, Mobile Touch | #67–#72, #74–#89 |
| DB | DB-1…DB-4 | #90–#93 |
| Discord/User/Goodbye | Discord-1, User-1, Goodbye-1 | #94–#96 |
| Leave | Leave-1A…1D, toggle, saga, cleanup legs, Rejoin-E2E Leave-1I | #97–#100, #152 |
| Nitrado | Coupling matrix, error modes, reconciliation, WL/Ban | (body unchecked PRs; code via Nitrado-1* PRs ~#126–#142) |
| Economy | 1I–1N, system account, rewards, playtime, admin-pay | #143–#151 |
| Dashboard early | 1A, 1B, 2F DEV Nitrado Mirror; **Etappe 23** inventory | #153, #154, #193, #194 |
| TOP-KRITISCH AI / HOCH DB / Discord / Leave / Nitrado / Economy | Duplicate restatements mostly `[x]` | same |

#### Unchecked `[ ]` (explicit open tracker debt)

| Block | Open items | Indicative audit stages |
|-------|------------|-------------------------|
| HOCH Dashboard/API/Mobile | Full authenticated E2E every control; desktop+320–430 mobile; full API AuthZ/Validation/Scope/IDOR/Race | **27–38** (and cross **23–35**) |
| HOCH Security | Secret scan; roles attack; CSRF/XSS/SSRF/IDOR/Injection/Path/Session/OAuth/Upload/Webhook; Dep/Container/SBOM final | **39–45** |
| HOCH Performance/Ops | Runtime baselines; leak; load/soak; heap; dep updates; passport-discord; inflight/glob; bundle>500kB; dead code | **46–57** |
| Abschluss | Full journey; chaos; Gesamtaudit 1–3; release SHA; Gate 1/2; Gate 2/2; main+Docker+Playwright; deploy+live smoke; 100/100 | **58–67** |

**Tracker conflict:** Docs/PRs exist for stages 27–63 with historical “verified” matrix statuses, yet #73 still leaves the corresponding HOCH/Abschluss boxes **unchecked**. Audit must re-prove at `48bbcffa`; do not close #73 boxes from this Step-1 artifact alone.

---

## 3. Per-stage skeleton (status empty / PENDING)

Machine-readable full table: [`stage-matrix-1-67.json`](./stage-matrix-1-67.json).

### Field contract (Auftrag §17-equivalent scoreboard row)

| Field | Meaning |
|-------|---------|
| `stage` | 1–67 |
| `title` | Short stage name |
| `status` | `PENDING` \| `VERIFIED` \| `PARTIAL` \| `FAILED` \| `BLOCKED` — **all PENDING after Step 1** |
| `issue73` | Checkbox path / label / open-closed |
| `mergedPrs` | Primary merge PR(s) if known |
| `docsMatrix` | Path under `docs/` if any |
| `basedOnShaInDocs` | SHA recorded inside matrix (often **stale** vs freeze SHA) |
| `codeHints` | Entry points for later steps (non-exhaustive) |
| `testsHints` | Test/e2e hints |
| `evidenceAtFreezeSha` | Filled in later evidence passes |
| `findings` | Finding IDs touching this stage |
| `notes` | Mapping / risk notes |

### Status legend (later fills)

- **VERIFIED** — all stage requirements proven on freeze SHA (code + coupling + adequate tests/gates).
- **PARTIAL** — material implementation present; gaps in tests, negative paths, or #73 contract.
- **FAILED** — missing auth/scope, fake success, broken CLI/gates attributable to product, or contradicted contract.
- **BLOCKED** — cannot complete without external access/credentials (e.g. prod live smoke) or upstream blocker.
- **PENDING** — not yet audited this engagement.

### Quick index 1–67

| Stage | Title | #73 | Primary PR / docs |
|------:|-------|-----|-------------------|
| 1 | AI provider registry foundation | AI-1 `[x]` | #67 |
| 2 | Ops bare-metal / runtime baseline setup | Ops-1 `[x]` | #68 |
| 3 | AI provider request compatibility | AI-2 `[x]` | #69 |
| 4 | AI conversation memory scope firewall | AI-3 `[x]` | #70 |
| 5 | AI DayZ technical grounding firewall | AI-4 `[x]` | #71 |
| 6 | Mobile touch-target hardening | Mobile `[x]` | #72 |
| 7 | AI memory scope explicit callsites | AI-5 `[x]` | #74 |
| 8 | AI prompt/context injection firewall | AI-6 `[x]` | #75 |
| 9 | AI capability registry + routing | AI-7 `[x]` | #76 |
| 10 | AI circuit-breaker / fallback | AI-8 `[x]` | #77 |
| 11 | AI context budget manager | AI-9 `[x]` | #78 |
| 12 | AI hybrid retrieval / RAG | AI-10 `[x]` | #79 |
| 13 | AI knowledge trust & freshness | AI-11 `[x]` | #80 |
| 14 | AI DayZ Knowledge 2.0 manifest | AI-12 `[x]` | #81 |
| 15 | AI general vs live server knowledge split | AI-13 `[x]` | #82 |
| 16 | AI Nitrado snapshot→knowledge index | AI-14 `[x]` | #83 |
| 17 | AI deterministic XML/JSON validation | AI-15 `[x]` | #84 |
| 18 | AI hallucination guard | AI-16 `[x]` | #85 |
| 19 | AI max user recognition chain | AI-17 `[x]` | #86 |
| 20 | AI hardened tool layer | AI-18 `[x]` | #87 |
| 21 | AI golden DayZ benchmark + eval | AI-19 `[x]` | #88 |
| 22 | AI observability | AI-20 `[x]` | #89 |
| 23 | Dashboard surface inventory | Etappe 23 `[x]` / open full E2E | #194 · `docs/dashboard-surface-inventory.json` |
| 24 | Dashboard button matrix | open full E2E | #195 · `docs/dashboard-button-matrix.json` |
| 25 | Dashboard switch matrix | open full E2E | #196 · `docs/dashboard-switch-matrix.md` |
| 26 | Dashboard CRUD matrix | open full E2E | #197 · `docs/dashboard-crud-matrix.json` |
| 27 | Dashboard action matrix | open full E2E | #198 · `docs/dashboard-action-matrix.json` |
| 28 | Dashboard pagination/search/filter | open | #199 · `docs/dashboard-pagination-matrix.json` |
| 29 | Dashboard error-state matrix | open | #200 · `docs/dashboard-error-state-matrix.json` |
| 30 | Dashboard desktop completion | open | #201 · `docs/dashboard-desktop-completion-matrix.json` |
| 31 | Mobile 320px matrix | open mobile | #202 · `docs/dashboard-mobile-320-matrix.json` |
| 32 | Mobile 360px matrix | open mobile | #203 · `docs/dashboard-mobile-360-matrix.json` |
| 33 | Mobile 375px matrix | open mobile | #204 · `docs/dashboard-mobile-375-matrix.json` |
| 34 | Mobile 390px matrix | open mobile | #205 · `docs/dashboard-mobile-390-matrix.json` |
| 35 | Mobile 430px matrix | open mobile | #206 · `docs/dashboard-mobile-430-matrix.json` |
| 36 | API authentication matrix | open API | #207 · `docs/dashboard-api-authentication-matrix.json` |
| 37 | API authorization / scope / IDOR | open API | #208 · `docs/dashboard-api-authorization-scope-idor-matrix.json` |
| 38 | API validation / race / idempotency | open API | #209 · `docs/dashboard-api-validation-race-idempotency-matrix.json` |
| 39 | Git history secret hygiene | open Security | #210 · `docs/git-history-secret-hygiene-matrix.json` |
| 40 | Roles/permission attack matrix | open Security | #211 · `docs/roles-permission-attack-matrix.json` |
| 41 | CSRF/XSS matrix | open Security | #212 · `docs/csrf-xss-matrix.json` |
| 42 | SSRF/injection/path traversal | open Security | #213 · `docs/ssrf-injection-path-traversal-matrix.json` |
| 43 | Session/OAuth security | open Security | #214 · `docs/session-oauth-security-matrix.json` |
| 44 | Upload/webhook security | open Security | #215 · `docs/upload-webhook-security-matrix.json` |
| 45 | Dependency/container/SBOM security | open Security | #216 · `docs/dependency-container-sbom-security-matrix.json` |
| 46 | Runtime baseline I | open Perf | #217 · `docs/runtime-baseline-i-matrix.json` |
| 47 | Runtime baseline II | open Perf | #218 · `docs/runtime-baseline-ii-matrix.json` |
| 48 | AI/Nitrado performance baseline | open Perf | #219 · `docs/ai-nitrado-performance-baseline-matrix.json` |
| 49 | Memory leak audit | open Perf | #220 · `docs/memory-leak-audit-matrix.json` |
| 50 | Load test | open Perf | #221 · `docs/load-test-matrix.json` |
| 51 | Soak test | open Perf | #222 · `docs/soak-test-matrix.json` |
| 52 | RAM/Node heap tuning | open Perf | #223 · `docs/ram-node-heap-tuning-matrix.json` |
| 53 | Dependency audit controlled updates | open Ops | #224 · `docs/dependency-audit-controlled-updates-matrix.json` |
| 54 | passport-discord migration | open Ops | #225 · `docs/passport-discord-migration-matrix.json` |
| 55 | inflight/glob cleanup | open Ops | #226 · `docs/inflight-glob-cleanup-matrix.json` |
| 56 | Dashboard bundle code-splitting | open Ops | #227 · `docs/dashboard-bundle-codesplit-matrix.json` |
| 57 | Dead code / legacy cleanup | open Ops | #228 · `docs/dead-code-legacy-cleanup-matrix.json` |
| 58 | Full user journey E2E | open Abschluss | #229 · `docs/full-user-journey-e2e-matrix.json` |
| 59 | Chaos test matrix | open Abschluss | #230 · `docs/chaos-test-matrix.json` |
| 60 | Gesamtaudit 1 code/architecture | open Abschluss | #231 · `docs/gesamtaudit-1-code-architecture-matrix.json` |
| 61 | Gesamtaudit 2 couplings | open Abschluss | #232 · `docs/gesamtaudit-2-couplings-matrix.json` |
| 62 | Gesamtaudit 3 production reality | open Abschluss | #233 · `docs/gesamtaudit-3-production-reality-matrix.json` |
| 63 | Release SHA freeze | open Abschluss | #234 · `docs/release-sha-freeze-matrix.json` |
| 64 | Final Gate 1/2 | open Abschluss | #235/#237/#238 (gate repairs + revalidation candidate) |
| 65 | Final Gate 2/2 | open Abschluss | #238 narrative (second cycle same SHA) |
| 66 | main Gate + Docker + Playwright | open Abschluss | push runs on `48bbcffa` (partial evidence only) |
| 67 | Production deploy + live smoke + score | open Abschluss | **no prod evidence in-repo** → default BLOCKED until access |

### Cross-cutting #73 domains **without exclusive stage numbers** (overlay)

These are audited **inside** stages above and as regression themes in Steps 2–4:

| Domain | #73 | Overlay stages / code |
|--------|-----|------------------------|
| DB-1…DB-4 | `[x]` claims | Scope gates across API/Economy/Leave; `prisma/`, `npm run db:consistency`, `db:lifecycle` |
| Leave full saga + rejoin | `[x]` claims | Workers/outbox; stages 37/40/58; leave modules |
| Nitrado WL/Ban/reconcile | `[x]` claims | Nitrado client/outbox; stages 48/58/61 |
| Economy ledger/isolation | `[x]` claims | Economy modules; stages 38/58 + isolation tests |
| Dashboard-1A…2F pre-23 | mixed | Absorbed into 23–35 evidence + early PRs #153–#193 |

---

## 4. Seed findings catalog

Full JSON: [`findings-seed.json`](./findings-seed.json).

| ID | Sev | Stages | Observation | Next action |
|----|-----|--------|-------------|-------------|
| F-PRE-01 | HIGH | 60–66, Test-Audit | Local `npm run test:ci` reported **21 failed / 415 passed** suites vs CI Tests **SUCCESS** on `48bbcffa` | Isolate env vs product vs gate-regex drift (Step 5) |
| F-PRE-02 | HIGH | 9/DB, 60–61 | `npm run db:consistency` failed (`$queryRawUnsafe`) | Root-cause script vs DB env (Step 5) |
| F-PRE-03 | HIGH | 45, 53 | Root `npm audit`: **3 high** `deepmerge-ts`; force-fix risks prisma major | Document exception or controlled upgrade |
| F-PRE-04 | MED | 56 | Vite bundle >500kB; #73 open | Measure chunks vs matrix |
| F-PRE-05 | MED | 54–55 | `passport-discord@0.1.4`, `inflight`, old `glob`; #73 open | Verify matrix vs lockfile at HEAD |
| F-PRE-06 | HIGH | 27–38, 58 | #73 Dashboard/API authenticated full matrix **unchecked** | Deep audit 27–38 |
| F-PRE-07 | HIGH | 39–52 | #73 Security + Perf blocks **unchecked** | Deep audit 39–52 |
| F-PRE-08 | HIGH | 63–67 | #73 Abschluss gates/deploy/100 **unchecked**; PR #238 ≠ tracker close | Gate/job proof + live BLOCKED policy |
| F-PRE-09 | MED→INFO | 66 | Playwright run `32525882181` now **SUCCESS** (was in_progress at plan draft) | Keep; still need 2/2 rule + local CLI |
| F-PRE-10 | MED | 60–64 | Architecture/runtime tests fail on pattern/`indexOf === -1` expectations | Product regression vs stale gates |
| F-PRE-11 | MED | 1–22 | #73 `[x]` foundation labels lack numeric stage IDs; mapping is audit-constructed | Use this matrix; prove in Step 3 |
| F-PRE-12 | HIGH | 63 | `docs/release-sha-freeze-matrix.json` still cites `basedOnMainSha: 45caf9cd` ≠ freeze `48bbcffa` | Stale freeze doc vs HEAD |
| F-PRE-13 | BLOCK | 67 | No production deploy/live-smoke credentials in audit scope | Status BLOCKED until explicit access |
| F-PRE-14 | MED | 64–65 | Only **one** main-push gate pair observed on `48bbcffa`; Issue 2/2 rule needs two **complete independent** cycles on immutable SHA (PR cycles vs main push — clarify in gate audit) | Step 4/5 GitHub archaeology |

### Failed local suites (names from plan session — reconfirm Step 5)

`economyTwoServerIsolationIntegration`, `dashboardPermissionIntegrityArchitecture`, `interactionDispatcherProduction`, `bankInterest`, `linkRewards`, `privilegedCommandFlow`, `nitradoWhitelistIntentGate`, `leaveRejoinLifecycleGate`, `nitradoTokenValidationLockGate`, `nitradoAdmBindingFenceGate`, `economyStructuredLedger`, `consoleLinkingCommands`, `getAccountOrZero`, `nitradoConfigLockConnectCleanupGate`, `botInfoConsistency`, `translatedPostImage`, `metricsBootstrap`, `translatedPostImageLimit`, `economyLottery`, `privilegedCommandDefinitions`, `nitradoModerationCommandSchema` (+ env-conditional isolation).

---

## 5. Aggregate scoreboard (Step 1 only)

| Metric | Value |
|--------|------:|
| Stages total | 67 |
| VERIFIED | 0 |
| PARTIAL | 0 |
| FAILED | 0 |
| BLOCKED | 0 (formal); **F-PRE-13** pre-marks 67 as blocked when evaluated |
| PENDING | 67 |
| FINAL SCORE | **n/a** (not scorable before evidence passes) |
| PRODUCTION READY | **NO** |

---

## 6. Artifacts produced this step

| Path | Purpose |
|------|---------|
| `docs/audit/masterplan-audit-baseline-step1.md` | Human baseline + mapping narrative |
| `docs/audit/stage-matrix-1-67.json` | Empty/PENDING status table 1–67 + refs |
| `docs/audit/findings-seed.json` | Seed findings catalog |
| `.issue73-body.txt` | Pre-existing body snapshot (untracked) |

---

## 7. Handoff to Step 2

- Freeze SHA for cycle 1: **`48bbcfface38068bc71ad7bcc5c1dd87616da514`**
- Any code change ⇒ new SHA ⇒ reset gate counters (Issue #73 rule)
- Step 2: structure/coupling crosscheck using `codeHints` paths; mark orphans/fake paths into findings
- Do not treat CI green or #73 `[x]` as VERIFIED
