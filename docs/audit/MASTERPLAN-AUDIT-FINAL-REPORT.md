# MASTERPLAN AUDIT – CURRENT RECONCILED STATE

This report is generated deterministically from `docs/audit/stage-matrix-1-67.json`.
Do not edit this report, the scoreboard, or the summary manually.

## Identity

| Field | Value |
| --- | --- |
| Generated | 2026-08-22T20:41:05.505Z |
| Final audited/evidence SHA | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` |
| Audit freeze SHA | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` |
| Stages total | 67 |

## Recalculated scoreboard

| Status | Count |
| --- | ---: |
| VERIFIED | 49 |
| PARTIAL | 17 |
| FAILED | 0 |
| BLOCKED | 1 |
| **TOTAL** | **67** |

**Current score: 73 / 100**

**PRODUCTION READY: NO**

## Complete stage matrix

| Stage | Status | Name | Evidence SHA | Residual / note |
| ---: | --- | --- | --- | --- |
| 1 | VERIFIED | stage-1 | — | — |
| 2 | VERIFIED | stage-2 | — | — |
| 3 | VERIFIED | stage-3 | — | — |
| 4 | VERIFIED | stage-4 | — | — |
| 5 | VERIFIED | stage-5 | — | — |
| 6 | VERIFIED | stage-6 | — | — |
| 7 | VERIFIED | stage-7 | — | — |
| 8 | VERIFIED | stage-8 | — | — |
| 9 | VERIFIED | stage-9 | — | — |
| 10 | VERIFIED | stage-10 | — | — |
| 11 | VERIFIED | stage-11 | — | — |
| 12 | VERIFIED | stage-12 | — | — |
| 13 | VERIFIED | stage-13 | — | — |
| 14 | VERIFIED | stage-14 | — | — |
| 15 | VERIFIED | stage-15 | — | — |
| 16 | VERIFIED | stage-16 | — | — |
| 17 | VERIFIED | stage-17 | — | — |
| 18 | VERIFIED | stage-18 | — | — |
| 19 | VERIFIED | stage-19 | — | — |
| 20 | VERIFIED | AI hardened tool layer | — | Production tool runtime and fail-closed read-only registry are merged and regression-tested. |
| 21 | VERIFIED | dashboard-surface-prep-21 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Rebind after 27-35 Playwright runtime matrix + authenticated e2e corpus on main |
| 22 | VERIFIED | dashboard-action-prep-22 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Rebind via authenticated action e2e suite (settings/economy/whitelist/tickets/...) |
| 23 | VERIFIED | dashboard-surface-inventory-23 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Surface inventory + runtime e2e matrix cover desktop/mobile routes |
| 24 | VERIFIED | dashboard-button-matrix-24 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Button matrix architecture + authenticated action e2e |
| 25 | VERIFIED | dashboard-switch-matrix-25 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Switch matrix architecture + settings mutation e2e |
| 26 | VERIFIED | dashboard-crud-matrix-26 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | CRUD matrix + dev/server CRUD e2e |
| 27 | VERIFIED | dashboard-action-matrix-27 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad action matrix plus real Chromium→Express→OAuth/session→AuthZ→Prisma proof commits the settings mutation and exactly one idempotency/audit side effect in both independent Playwright jobs. |
| 28 | VERIFIED | pagination-search-filter-cursor-28 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | Real PostgreSQL AuditLog data is searched and filtered through the production API; the UI appends cursor page two from 50 to all 55 rows without loss in both independent Playwright jobs. |
| 29 | VERIFIED | dashboard-error-state-matrix-29 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad error matrix is supplemented by a real persisted-session revocation: the production UI receives 401, renders no false success and PostgreSQL confirms no settings mutation. |
| 30 | VERIFIED | dashboard-desktop-completion-30 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The desktop completion matrix plus real authenticated PostgreSQL-backed server, guild and settings routes render at 1280 px without horizontal overflow in both independent Playwright jobs. |
| 31 | VERIFIED | mobile-matrix-320px-31 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad 320 px mobile matrix plus the real authenticated DB-backed settings route proves visible controls/navigation and no horizontal overflow. |
| 32 | VERIFIED | mobile-matrix-360px-32 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad 360 px mobile matrix plus the real authenticated DB-backed settings route proves visible controls/navigation and no horizontal overflow. |
| 33 | VERIFIED | mobile-matrix-375px-33 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad 375 px mobile matrix plus the real authenticated DB-backed settings route proves visible controls/navigation and no horizontal overflow. |
| 34 | VERIFIED | mobile-matrix-390px-34 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad 390 px mobile matrix plus the real authenticated DB-backed settings route proves visible controls/navigation and no horizontal overflow. |
| 35 | VERIFIED | mobile-matrix-430px-35 | `a93b4b986308bf5be9fe5119e2c5eb0f72813254` | The broad 430 px mobile matrix plus the real authenticated DB-backed settings route proves visible controls/navigation and no horizontal overflow. |
| 36 | VERIFIED | api-authentication-36 | `eb10b85130b4481e361a234cbb005b740ebd40b3` | VERIFIED by the real HTTP+PostgreSQL OAuth callback, SID rotation, revocation, /api/me and /auth/status chain in both successful complete Jest jobs on PR #264 evidence head a31827d1593b8ac79e74dc2dd69e81beb90142d9 (CI/CD 32590954868; Verification 2 32590954874). |
| 37 | VERIFIED | api-authorization-idor-37 | `eb10b85130b4481e361a234cbb005b740ebd40b3` | VERIFIED by the real HTTP+PostgreSQL foreign-guild TicketTemplate IDOR denial and unchanged-row assertion in both successful complete Jest jobs on PR #264 evidence head a31827d1593b8ac79e74dc2dd69e81beb90142d9 (CI/CD 32590954868; Verification 2 32590954874). |
| 38 | VERIFIED | api-validation-race-idempotency-38 | `eb10b85130b4481e361a234cbb005b740ebd40b3` | VERIFIED by the real concurrent HTTP+PostgreSQL claim test proving one claim and exactly one AuditLog side effect in both successful complete Jest jobs on PR #264 evidence head a31827d1593b8ac79e74dc2dd69e81beb90142d9 (CI/CD 32590954868; Verification 2 32590954874). |
| 39 | VERIFIED | git-history-secret-hygiene-39 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Gitleaks full-history blocking on CI security job; main clean |
| 40 | VERIFIED | roles-permission-attack-40 | `2a7c048d1d1a1206d0774da26d70c363cc225fcf` | Permission/IDOR + stale grant + DEV/BotAdmin identity gates runtime-verified |
| 41 | VERIFIED | csrf-xss-41 | `eb10b85130b4481e361a234cbb005b740ebd40b3` | VERIFIED by successful Origin/Fetch-Metadata regression tests and the TypeScript-AST sink scan in both complete Jest jobs on PR #264 evidence head a31827d1593b8ac79e74dc2dd69e81beb90142d9 (CI/CD 32590954868; Verification 2 32590954874). |
| 42 | VERIFIED | ssrf-injection-path-42 | `2a7c048d1d1a1206d0774da26d70c363cc225fcf` | CI-local SSRF, SQL/command injection and path traversal contracts are closed. The explicitly external production-egress validation is transferred to Stage 67. |
| 43 | VERIFIED | session-oauth-43 | `eb10b85130b4481e361a234cbb005b740ebd40b3` | VERIFIED by the real HTTP+PostgreSQL OAuth callback/SID rotation and token-cache revocation chain in both successful complete Jest jobs on PR #264 evidence head a31827d1593b8ac79e74dc2dd69e81beb90142d9 (CI/CD 32590954868; Verification 2 32590954874). Live Discord OAuth remains isolated to Stage 67. |
| 44 | VERIFIED | upload-webhook-security-44 | `3f8f281fb25d5e2dae1b1e933fde056b315b1d95` | Webhook HMAC/replay + upload path/size + MIME magic-bytes/content validation runtime-verified; residual empty |
| 45 | VERIFIED | stage-45-deps-sbom-trivy | `2a7c048d1d1a1206d0774da26d70c363cc225fcf` | Root/dashboard HIGH audit + SBOM + Trivy CRITICAL/HIGH blocking + Vite 6.4.3 on main |
| 46 | PARTIAL | runtime-baseline-i-46 | — | residual-current-sha-rss-heap-cpu-gc-eventloop-series; F-S4-06 |
| 47 | PARTIAL | runtime-baseline-ii-47 | — | residual-current-sha-db-redis-worker-queue-measurements; F-S4-06 |
| 48 | PARTIAL | ai-nitrado-perf-48 | `ce68d05e6074ce95d7e417d1c063bddfa0e17206` | residual-live-provider-rtt; F-S4-06 |
| 49 | PARTIAL | memory-leak-audit-49 | — | residual-current-sha-rss-heap-listener-handle-series |
| 50 | PARTIAL | load-test-50 | `8f181c7e8f2344f0c78dcd19a3151547f885aa17` | residual-full-stack-load |
| 51 | PARTIAL | soak-test-51 | `8f181c7e8f2344f0c78dcd19a3151547f885aa17` | residual-multi-hour-soak |
| 52 | PARTIAL | ram-node-heap-tuning-52 | — | residual-stage-46-51-measurements-before-final-tuning-decision |
| 53 | VERIFIED | dependency-audit-controlled-53 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Controlled updates; lockfile + Stage45 high blocking; no blind majors |
| 54 | VERIFIED | passport-discord-migration-54 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | passport/passport-discord removed; custom PKCE OAuth canonical |
| 55 | VERIFIED | inflight-glob-cleanup-55 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | No prod inflight; Jest29 glob/inflight dev-only residual classified |
| 56 | VERIFIED | dashboard-bundle-codesplit-56 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | All JS chunks <500kB on Vite 6.4.3; entry ~64kB; vendor+lazy split |
| 57 | PARTIAL | dead-code-legacy-cleanup-57 | — | residual-full-coupling-and-reference-analysis-before-cleanup |
| 58 | PARTIAL | full-user-journey | `8f181c7e8f2344f0c78dcd19a3151547f885aa17` | F-S4-10; residual-live-discord-gateway |
| 59 | PARTIAL | chaos | `8f181c7e8f2344f0c78dcd19a3151547f885aa17` | F-S4-11; residual-docker-process-kill |
| 60 | PARTIAL | gesamtaudit-60-code | `bdf190b881573a78896152e6ec0dbe6e542e7e1a` | dynamic-import-graph-residual |
| 61 | PARTIAL | gesamtaudit-61-couplings | `bdf190b881573a78896152e6ec0dbe6e542e7e1a` | full-dynamic-import-orphan-sweep |
| 62 | PARTIAL | gesamtaudit-62-prod-reality | `bdf190b881573a78896152e6ec0dbe6e542e7e1a` | live-production-deploy-stage-67 |
| 63 | PARTIAL | release-sha | — | F-S4-13 |
| 64 | PARTIAL | final-gate-1 | — | F-S4-14 |
| 65 | PARTIAL | final-gate-2 | — | F-S4-14 |
| 66 | PARTIAL | main-gate | — | no-merge-this-session |
| 67 | BLOCKED | production-live | — | F-S4-15; stage-42-live-production-network-egress-validation |

## Remaining residuals (priority order)

- Stage 46 (PARTIAL): residual-current-sha-rss-heap-cpu-gc-eventloop-series; F-S4-06
- Stage 47 (PARTIAL): residual-current-sha-db-redis-worker-queue-measurements; F-S4-06
- Stage 48 (PARTIAL): residual-live-provider-rtt; F-S4-06
- Stage 49 (PARTIAL): residual-current-sha-rss-heap-listener-handle-series
- Stage 50 (PARTIAL): residual-full-stack-load
- Stage 51 (PARTIAL): residual-multi-hour-soak
- Stage 52 (PARTIAL): residual-stage-46-51-measurements-before-final-tuning-decision
- Stage 57 (PARTIAL): residual-full-coupling-and-reference-analysis-before-cleanup
- Stage 58 (PARTIAL): F-S4-10; residual-live-discord-gateway
- Stage 59 (PARTIAL): F-S4-11; residual-docker-process-kill
- Stage 60 (PARTIAL): dynamic-import-graph-residual
- Stage 61 (PARTIAL): full-dynamic-import-orphan-sweep
- Stage 62 (PARTIAL): live-production-deploy-stage-67
- Stage 63 (PARTIAL): F-S4-13
- Stage 64 (PARTIAL): F-S4-14
- Stage 65 (PARTIAL): F-S4-14
- Stage 66 (PARTIAL): no-merge-this-session
- Stage 67 (BLOCKED): F-S4-15; stage-42-live-production-network-egress-validation

## Integrity contract

- `VERIFIED + PARTIAL + FAILED + BLOCKED = 67`.
- Every non-VERIFIED stage names at least one residual/finding.
- A VERIFIED stage cannot retain findings.
- JSON, CSV, and Markdown outputs are UTF-8 without BOM and use LF line endings.
- `npm run audit:check` fails on drift instead of silently regenerating in CI.
