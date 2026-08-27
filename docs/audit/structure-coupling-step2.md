# Step 2 — Repo-weiter Struktur- und Kopplungs-Crosscheck

**Freeze SHA:** `48bbcfface38068bc71ad7bcc5c1dd87616da514` (`48bbcffa`)  
**Branch:** `main` = `origin/main` (re-verified this session)  
**Mode:** audit only — application code/tests untouched  
**Evidence hierarchy:** runtime mounts + producer/consumer imports > architecture gate tests > unit mocks > docs/PR text

Machine-readable companion: `docs/audit/structure-coupling-map.json`  
New findings: `docs/audit/findings-step2.json` (merge with seed later)

---

## 1. Top-level layout (confirmed)

| Area | Path | Role |
|------|------|------|
| Bot entry | `src/index.ts`, `src/shard.ts` | Discord client, schedulers, dashboard + nitrado runtime |
| Config | `src/config.ts` | Env-backed config |
| Commands | `src/commands/**` | Slash/catalog + dashboard domain commands |
| Events | `src/events/**` (11) | Gateway handlers registered in `index.ts` |
| Domain modules | `src/modules/**` (~190 TS under modules) | AI, economy, nitrado, moderation/leave, whitelist, bans, … |
| Dashboard API | `src/dashboard/**` (~140 TS) | Express server, middleware, v2 routes, services |
| Scope types | `src/types/scope.ts` | Guild/gameserver permission model |
| DB client | `src/database/prisma.ts` | Prisma singleton |
| Schema | `prisma/schema.prisma` + split `prisma/*.prisma` + migrations | Truth store |
| UI | `dashboard-ui/src/{pages,components,lib}` | Vite React SPA |
| Tests | `tests/{ai,commands,dashboard,database,deploy,e2e-live,modules,runtime,security,utils}` | Jest + gates |
| Deploy | `deploy/*`, `Dockerfile`, `docker-compose.yml` | Ops scripts + container |
| CI | `.github/workflows/{ci,e2e,final-dependency-hardening,verification2}.yml` | Gates |
| Perf/chaos scripts | `scripts/{load-test,soak-test,chaos-smoke,runtime-baseline*}.mjs` | Ops smoke (not prod proof alone) |

`src/modules` package counts (approx TS files): ai 63, nitrado 37, economy 18, moderation 15, feeds 8, whitelist 5, bans 5, linking 5, gameplayFeeds 3, + smaller domains.

---

## 2. Process bootstrap graph (runtime-confirmed)

```
main (src/index.ts)
  assertProductionEnv
  prisma.$connect  → fail-exit
  acquireSingletonLock
  Client + loadCommands
  registerBotEventsSafely([ready, interactionCreate, member*, message*, voice*, …])
  client.login
  startDashboard(client)  → FAIL-FAST process abort if dashboard fails
  startNitradoRuntime(client)  → warn-only on init failure  ⚠
  startGiveawayScheduler / lottery / feeds / polls / rateLimit / reminders
  setInterval processExpiredCasesSafely (moderation cases)
  clientReady once:
    deployCommandsScoped
    startAiBackgroundLoops(client)  → best-effort subsystems

ready (src/events/ready.ts)
  restoreAllFeeds (leaderboard)
  startAuditLogRetentionScheduler
  startMemberSyncScheduler
  startLeaveCleanupWorker

startNitradoRuntime (src/modules/nitrado/runtime.ts)
  startNitradoJobWorker
  startBanExpiryRuntime
  startBanReconciliationCron
  startTokenValidationCron
  startPermaOnlyCron
  startWhitelistSyncCron
  startAdmLiveSyncCron + startAdmPostProcessCron
  startGameplayFeedRuntime
  startBankInterestCron
```

**Coupling note:** Economy bank interest and ban expiry/reconcile are started *inside* Nitrado runtime, not from `index.ts` directly — intentional packaging, not orphans.

**Risk:** Nitrado runtime init is warn-only; bot can run without outbox consumers if `startNitradoRuntime` throws.

---

## 3. Dashboard HTTP mount map (runtime-confirmed)

Source: `src/dashboard/server.ts` + `src/dashboard/routes/v2.ts`

| Mount | Router | Auth boundary |
|-------|--------|---------------|
| `/auth/*` | `routes/auth.ts` | OAuth/session/2FA; login limiters on login/callback/2fa |
| `/webhooks/*` | `routes/webhooks.ts` | No session; HMAC + rawBody |
| `/api/health/*` | `discordHealth.ts` | Before generic `/api` (owner self-service) |
| `/api/*` | `routes/api.ts` | Session `requireAuth`; **only** `GET /me` remains |
| `/api/v2/*` | `routes/v2.ts` | Global `requireAuth` + `idempotency` on **all** v2 |
| `/test/*` | `routes/test.ts` | Session + `user.role ∈ {ADMIN,DEVELOPER}` |
| `/transcripts/*` | `transcripts.ts` | Public UUID URLs |
| `/health`, `/health/ready` | inline + readinessHandler | Liveness open; ready = DB+session |
| `/metrics` | conditional | Bearer `METRICS_TOKEN` |
| `/uploads/factions`, media | static | Public asset dirs only |
| SPA fallback | static dashboard-ui build | After API routes |

### v2 domain mounts (`v2.ts`)

All under `/api/v2` after session auth:

| Path suffix | Extra gates | Module file |
|-------------|-------------|-------------|
| `/guilds` | — | `v2/guilds.ts` |
| `/guilds/:guildId/dashboard` | — | `v2/dashboard.ts` |
| `/guilds/:guildId/permissions` | — | `v2/permissions.ts` |
| `/guilds/:guildId/nitrado` | (write guards in route) | `v2/nitrado.ts` |
| `/guilds/:guildId/adm-source` | — | `v2/admSource.ts` |
| `/guilds/:guildId/tickets` | — | `v2/tickets.ts` |
| `/guilds/:guildId/whitelist` | — | `v2/whitelist.ts` |
| `/guilds/:guildId/factions` | faction perms + hardening MW | `v2/factions.ts` |
| `/guilds/:guildId/economy-scope` | — | `v2/economyScope.ts` |
| `/guilds/:guildId/economy/*` | `economy.view|manage` + `requireSafeDashboardEconomyScope` | economy* routers |
| `/guilds/:guildId/economy-links` | — | `v2/economyLink.ts` |
| `/guilds/:guildId/casino` | casino perms + economy scope | `v2/casino.ts` |
| `/guilds/:guildId/killfeed` | — | `v2/killfeed.ts` |
| `/guilds/:guildId/welcome|goodbye|leave-cleanup` | — | welcome/goodbye/leaveCleanup |
| embeds / reaction-embeds / feeds / translated-posts / audit | — | respective routers |
| `/dev/*` | `requireGlobalDeveloperIdentity` ± `requireDev` ± step-up | dev* routers |
| `/bot-admin/*` | `requireGlobalBotAdminIdentity` ± `requireBotAdmin` + safety routers | botAdmin* |

Middleware inventory (`src/dashboard/middleware/`):  
`auth`, `idempotency`, `guildDomainAccess`, `economyScopeGuard`, `nitradoWriteGuard`, `globalDeveloperGate`, `globalBotAdminGate`, `devStepUp`, `devSecurity*`, `commandCenterInputGuard`, `botAdminGuildReferenceGuard`, faction hardening, `v2AsyncErrorBoundary`.

---

## 4. UI → API surface (confirmed + inferred)

### Confirmed UI entry points

| UI | API pattern |
|----|-------------|
| `dashboard-ui/src/lib/api.ts` | Canonical fetch helper → `/api/v2/...`, `/auth/...` |
| `pages/Server.tsx` | `GET /api/v2/guilds/:id/dashboard` + tabs: nitrado, aliases, permissions, tickets, factions, welcome, embeds, reaction-embeds, feeds, translate, audit |
| `pages/ServerSlot.tsx` | Gameserver-scoped economy/whitelist/killfeed/linking/etc. (heavy `/api/v2/guilds/...` usage) |
| Leave | `components/LeaveCleanupPanel.tsx` → leave-cleanup routes |
| Goodbye/Welcome | panels → welcome/goodbye routes |
| BotAdmin / Dev | dedicated pages + `lib/devToolsCatalog.ts`, botAdmin session libs |

### DEV catalog vs stubs

- `devToolsCatalog.ts`: **all tools `status: 'ready'`** (no `'stub'` entries).
- `pages/dev/_ToolStub.tsx`: still present as Phase-2 placeholder component.
- `components/dev/EnterpriseStub.tsx`: **no importers** in `dashboard-ui` → **orphan UI component** (dead code path).
- Backend `devStubs.ts` / `devDiagnosticsStubs.ts` are **mounted** under `/api/v2/dev/stubs` with GlobalDev + DevSession + step-up — not “unmounted”, but named stubs; they claim live data for remaining diagnostic pages.

**Later stage work:** map each DEV analysis slug (adm-analysis, heatmap, …) handler-by-handler for real ADM query vs empty shell (catalog “ready” is not product proof).

---

## 5. Critical producer → consumer chains

### 5.1 Leave / Rejoin (primary)

```
Producer (gateway):
  guildMemberRemove
    → CAS revoke GuildPermissionGrant (membership-epoch aware)
    → getLeaveCleanupConfig → if deletePlayerDataOnLeave:
         enqueueLeaveCleanupRequest (early + post markMemberLeft)
    → syncMemberProfile + markMemberLeft
    → sendConfiguredGoodbye (best-effort AFTER durable enqueue)

Producer (gateway rejoin):
  guildMemberAdd
    → delete stale grants (updatedAt < joinedAt)
    → syncMemberProfile
    → hasOpenLeaveCleanupRequest (fail-closed → skip level baseline if open/error)
    → optional levelData upsert only if cleanup not open
    → autoroles + welcome

Config API:
  UI LeaveCleanupPanel → /api/v2/guilds/:id/leave-cleanup → leaveCleanupConfig module

Consumer (in-process poller):
  startLeaveCleanupWorker (ready)
    claimNextLeaveCleanupRequest + recoverStaleLeaveCleanupRequests
    steps: WHITELIST → STATS_SESSIONS → LINK_ECONOMY → GUILD_DATA → COMPLETE
    lease heartbeat (leaveCleanupLease)
    finalizeLeaveRejoinState (leaveCleanupRejoin)

Side effects:
  leaveCleanupWhitelist → whitelist remove intents / outbox
  leaveCleanupLinkEconomy → linking + economy wipe scoped
  guildMemberCleanup → guild-scoped player rows
```

**DB:** Leave cleanup request/saga tables (via Prisma models used in `leaveCleanupSaga.ts`).  
**Not Redis/Bull:** durable DB outbox/saga pattern.

### 5.2 Nitrado job outbox + whitelist/ban

```
Producers:
  whitelistApprovalButton / dashboard whitelist routes / commands/dashboard/whitelist
    → whitelistEntry upsert + enqueueWhitelistAdd/Remove (whitelistOutbox)
  serverBan commands/routes
    → ban registry + enqueueServerBanAdd/Remove (banOutbox)
  keepOnline / ADM path
    → KEEPALIVE, DOWNLOAD_ADM, RESTART_IF_DOWN jobs
  privileged/economy pending money
    → pendingServerAction (separate lease table, not NitradoJob ops list)

Consumer:
  startNitradoJobWorker (jobWorker.ts)
    claimNitradoJob + advisory lock per nitradoConnId
    ops: WHITELIST_ADD|REMOVE, SERVER_BAN_ADD|REMOVE, KEEPALIVE, DOWNLOAD_ADM, RESTART_IF_DOWN
    WHITELIST_* → nitradoClient + reconcileWhitelistRemoteIntent (whitelistIntent)
    unknown op → permanent DEAD

Parallel crons (same runtime):
  whitelistSyncCron → remote↔local reconcile (intent-aware PENDING_REMOVE)
  banReconciliationCron + ban expiryRuntime
  tokenValidationCron, permaOnlyCron
  admLiveSyncCron + admPostProcessCron → gameplayFeeds runtime
```

### 5.3 Economy

```
Write primitive:
  bookLedgerEntry / bookLedgerEntryInTx (ledger.ts)
    → EconomyLedgerEntry + EconomyAccount (guildId+nitradoConnId+userDiscordId)

Producers:
  rewardBooking / playtimeBooking / rewardCursor (ADM/events driven)
  bankInterest + interestCron (started via nitrado runtime)
  lottery scheduler (index.ts)
  blackMarket / virtualAccounts / dashboardAdminPay / pendingAdminMoney
  linkRewards (linking module)
  Discord commands: commands/dashboard/economy|lottery|casino|virtualAccounts|…
  Dashboard v2: economy*, casino, economy-links (+ economyScopeGuard)

Scope:
  requireSafeDashboardEconomyScope on money UIs
  Phase-4 server scope mandatory on ledger (no guild-wide money)
```

### 5.4 AI / RAG / tool layer

```
Interactive:
  messageCreate / commands/user/ai → aiHandler → contextBuilder
    → findRelevantKnowledge (guildKnowledge + embeddings + knowledgeScope/provenance)
    → provider stack (modelRegistry, providerStats, providerFailure, …)

Background (startAiBackgroundLoops):
  providerStats cooldown hydrate + periodic sync
  guildAwareness bootstrap + content sync
  embeddings check + backfill (best-effort)
  conversationMemory cleanup
  translatedPostScheduler

Tool boundary:
  src/modules/ai/toolLayer.ts  AiToolExecutor
  src/security/aiToolStepUp.ts AiToolStepUpService
  tests/ai/toolLayer.test.ts + tests/security/aiToolLayerArchitecture.test.ts

⚠ RUNTIME GAP: No production import of AiToolExecutor outside toolLayer.ts itself.
  No tool registration wiring from aiHandler. Integration layer absent at HEAD.
  Architecture test only proves import hygiene + unit semantics — not live tool calls.
```

### 5.5 AuthZ model (cross-cutting)

- Discord OAuth session (`auth.ts` routes + `express-session` PG store).
- Guild domain permissions: `modules/permissions/access` + `guildDomainAccess` middleware + `types/scope`.
- Direct grants: CAS on leave/rejoin (`guildMemberRemove`/`Add`).
- Dev: Global developer identity + DevSession + optional MFA + IP allowlist (**empty allowlist = fail-open**, documented in `middleware/auth.ts`).
- Bot-admin: Global bot-admin identity + BotAdminSession + danger/safety routers.
- Idempotency middleware on all v2 mutations (A1).

---

## 6. Queues / workers inventory

| Worker/Cron | Start site | Backing store | Consumer confirmed? |
|-------------|------------|---------------|---------------------|
| Leave cleanup worker | ready.ts | DB saga/requests | Yes |
| Nitrado job worker | nitrado/runtime | NitradoJob + lease | Yes |
| Whitelist sync cron | nitrado/runtime | DB + remote API | Yes |
| Ban expiry + reconcile | nitrado/runtime | ban tables + outbox | Yes |
| Token validation cron | nitrado/runtime | validation health | Yes |
| Perma-only cron | nitrado/runtime | — | Yes |
| ADM live + postprocess | nitrado/runtime | ADM pipeline tables | Yes |
| Gameplay feed runtime | nitrado/runtime | feed delivery | Yes |
| Bank interest cron | nitrado/runtime | ledger | Yes |
| Lottery / giveaway / poll / feed / reminder | index.ts | domain tables | Yes |
| Member sync scheduler | ready.ts | member profiles | Yes |
| Audit retention | ready.ts | audit logs | Yes |
| AI loops | index clientReady | knowledge/embeddings | Yes (best-effort) |
| Case expiry interval | index.ts | moderation cases | Yes |
| Dashboard cleanup timers | dashboard runtime | uploads/dev sessions | Yes |
| **Bull/BullMQ/Redis queues** | — | — | **None found** |

No classic message-broker orphans; durability is Postgres outbox/saga.

---

## 7. Fake / orphan / fail-open candidates

| ID | Severity | Kind | Evidence | Notes |
|----|----------|------|----------|-------|
| F-S2-01 | HIGH | Integration gap | `AiToolExecutor` only used in tests | AI-18 boundary exists; **no prod registration/execute path** |
| F-S2-02 | MED | Fail-open | Dev IP allowlist empty = fail-open (`middleware/auth.ts` comment) | Documented; still audit risk for prod |
| F-S2-03 | MED | Soft-fail runtime | `startNitradoRuntime` catch warn-only in index.ts | Bot up without job consumers |
| F-S2-04 | MED | Soft-fail AI | AI background subsystems warn-and-continue | RAG/translate may be silently off |
| F-S2-05 | LOW | Orphan UI | `EnterpriseStub` zero imports | Dead component |
| F-S2-06 | LOW | Residual stub UI | `_ToolStub.tsx` still in tree | Catalog marks all ready — verify analysis pages in stage 27–35 |
| F-S2-07 | MED | Broad admin surface | `/test/*` role ADMIN/DEVELOPER cross-tenant counts/toggles | Mounted in prod server; relies on role only |
| F-S2-08 | INFO | Naming | `devStubs` routes are live diagnostics, not unmounted | Don’t flag as orphan; audit content depth later |
| F-S2-09 | MED | Catalog vs proof | All DEV tools `ready` | Status is UI metadata, not E2E proof |
| F-S2-10 | LOW | Dual API | Legacy `/api/me` + v2 | Intentional slim legacy |
| F-PRE-* | — | — | From step 1 | Still open (local test:ci, db:consistency, deps, gates) |

**Not found as orphans (positive):**

- v2 routers listed in `v2.ts` are all imported and `use`d.
- Whitelist/ban outbox producers pair with `jobWorker` ops set.
- Leave enqueue pairs with `leaveCleanupWorker`.
- Dashboard hard-required at boot (no headless-prod bot without API).

---

## 8. Prisma / DB touchpoints (map, not full schema audit)

- Canonical schema: `prisma/schema.prisma` + domain fragments (`economy-*`, `nitrado-*`, `ai-knowledge-*`, …).
- Active migrations under `prisma/migrations/`; large `migrations_legacy/` historical.
- CI Test job runs `prisma migrate deploy`, `migrate status`, `db:consistency`, `db:lifecycle` then jest (`ci.yml`) — explains part of local vs CI divergence if local DB/env missing.
- Consistency scanner scripts: package scripts `db:consistency`, `db:lifecycle` (root).

---

## 9. Tests ↔ subsystems (pointers for stages 3–5)

| Domain | Example tests |
|--------|----------------|
| Leave | `tests/modules/leaveCleanup*.test.ts`, rejoin, lease, whitelist, linkEconomy |
| Nitrado | `tests/modules/nitrado*.test.ts`, job worker, locks, ADM fence |
| Whitelist/Ban | banOutbox/reconciliation, whitelist gates under runtime/architecture |
| Economy | ledger, lottery, bankInterest, virtual accounts, isolation integration |
| AI | `tests/ai/*`, toolLayer, security aiToolLayerArchitecture, dayz grounding |
| Dashboard | `tests/dashboard/*`, permission integrity architecture |
| Security | `tests/security/*` |
| Deploy | `tests/deploy/*`, e2e-live |

Architecture/gate tests that fail locally (step1 F-PRE-01/10) may be **string contract drift** — treat as findings until code match proven.

---

## 10. Deploy / Docker / workflows (structure only)

| Artifact | Role |
|----------|------|
| `Dockerfile` | Production image |
| `docker-compose.yml` | Local/stack |
| `deploy/bot.sh`, `update.sh`, `setup.sh`, `smoke.sh` | Host deploy + smoke |
| `deploy/backup*.sh`, `db-lifecycle-verify.sh` | Backup/lifecycle |
| `.github/workflows/ci.yml` | Lint/build, tests+DB, security, docker, publish |
| `e2e.yml` | Playwright |
| `verification2.yml`, `final-dependency-hardening.yml` | Extra gates |

Stage 63–67 must bind runs to freeze SHA (step1 already listed run IDs).

---

## 11. Commands used this step

```powershell
git rev-parse HEAD; git status -sb; git rev-parse origin/main
# directory inventories via Get-ChildItem on src, modules, dashboard routes, prisma, scripts, workflows, deploy, dashboard-ui pages
# greps: express mounts, Queue/outbox, AiToolExecutor, ToolStub, fail-open/stub, whitelist enqueue, job operations
```

High-ROI for later stages:

```powershell
# Confirm freeze
git rev-parse HEAD
# Route mount truth
# open src/dashboard/routes/v2.ts + server.ts
# Chain seeds
# open src/modules/nitrado/runtime.ts, leaveCleanupWorker.ts, jobWorker.ts KNOWN_OPERATIONS
# AI tool wiring proof
rg -n "AiToolExecutor|from ['\"].*toolLayer" src tests
# UI API usage for a feature
rg -n "/api/v2/guilds/.*/economy" dashboard-ui/src
```

---

## 12. Handoff to Step 3 (Etappen 1–26)

Use this map + `structure-coupling-map.json` `codeHints`/chains.  
Do **not** mark VERIFIED from #73 `[x]` or catalog `ready`.  
Priority deep-dives already flagged: **AI tool wiring (F-S2-01)**, **Nitrado soft-start (F-S2-03)**, **dev allowlist fail-open (F-S2-02)**, leave/economy/nitrado chains as primary evidence paths.

**PRODUCTION READY:** still **NO** (structure pass only; step1 red signals unchanged).
