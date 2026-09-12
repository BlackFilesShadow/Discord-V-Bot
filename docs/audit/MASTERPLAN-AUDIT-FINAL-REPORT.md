# MASTERPLAN AUDIT – CURRENT RECONCILED STATE

This report is generated deterministically from `docs/audit/stage-matrix-1-67.json`.
Do not edit this report, the scoreboard, or the summary manually.

## Identity

| Field | Value |
| --- | --- |
| Generated | 2026-09-12T20:38:39.000Z |
| Final audited/evidence SHA | `3c4abb74c87467eda7edd0ea396afac59b270262` |
| Audit freeze SHA | `3c4abb74c87467eda7edd0ea396afac59b270262` |
| Stages total | 67 |

## Recalculated scoreboard

| Status | Count |
| --- | ---: |
| VERIFIED | 60 |
| PARTIAL | 6 |
| FAILED | 0 |
| BLOCKED | 1 |
| **TOTAL** | **67** |

**Current score: 90 / 100**

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
| 46 | VERIFIED | runtime-baseline-i-46 | `2c16bcbe870f9d4818d7ed4726b95ef2879e30d9` | A bounded current-SHA 12-sample series records and interprets RSS, heap, external/array buffers, CPU, 63 GC events, event-loop p50/p99/max, active resources/requests/handles and listeners; both complete Jest jobs execute the regression. |
| 47 | VERIFIED | runtime-baseline-ii-47 | `17c5f4306ac7640c863d4954e4b4f39e0c227bc6` | Two independent mandatory live jobs on the exact SHA measured PostgreSQL 16 pool saturation/backpressure, Redis 7 latency/concurrency/TTL and persistent queue depth/claim/index behavior. Productive depth, oldest-pending and in-flight gauges are wired; both artifacts have empty residuals. |
| 48 | VERIFIED | ai-nitrado-perf-48 | `025a1ebf134a1453b675c315ca641cd0c32918aa` | Two independent mandatory exact-SHA CI jobs measured real-TCP loopback latency and concurrency through the production AI and Nitrado clients, bounded 503/429 retries, AI provider fallback, Nitrado circuit fail-fast and low-cardinality metrics. External production-provider RTT is an explicit Stage 67 credential boundary and is not claimed here. |
| 49 | VERIFIED | memory-leak-audit-49 | `2c16bcbe870f9d4818d7ed4726b95ef2879e30d9` | Bounded-map/timer/cache audits and churn regressions are supplemented by an exact-SHA allocation/recovery series: RSS 0.0338 MiB/sample, heap 0.0071 MiB/sample, active-resource slope 0 and listener slope 0. The longer full-stack soak remains Stage 51. |
| 50 | VERIFIED | load-test-50 | `1cf8822b39615b94d52c28b32d03a481062a3bd2` | Two independent mandatory exact-SHA CI jobs loaded the production dashboard over real loopback TCP with live PostgreSQL readiness/session-store traffic and fail-closed API auth. CI measured 898.078 RPS at HTTP p50/p95/p99 19.053/35.436/60.780 ms; Verification 2 measured 702.308 RPS at 24.645/47.411/110.711 ms. Both had zero request errors, bounded database/event-loop latency, complete CPU/heap/RSS measurements, deterministic cleanup and empty residuals. Multi-sample long-duration soak remains the distinct Stage 51 scope; credentialed external traffic remains Stage 67. |
| 51 | VERIFIED | soak-test-51 | `b540786f857f16f8ec422288f020b30328034278` | Two complete gate cycles and two dedicated soak runs succeeded on unchanged SHA b540786f. The final two-hour isolated-CI run processed 1,062,972 requests with zero failures, bounded latency/resources and full PostgreSQL runtime traffic. |
| 52 | VERIFIED | ram-node-heap-tuning-52 | `2bed7f7fed0c86e071a87a3fbca05076d4bc7166` | Measured Stage 46-51 evidence supports retaining Node/V8 defaults; the guard rejects an unreviewed production heap override. |
| 53 | VERIFIED | dependency-audit-controlled-53 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | Controlled updates; lockfile + Stage45 high blocking; no blind majors |
| 54 | VERIFIED | passport-discord-migration-54 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | passport/passport-discord removed; custom PKCE OAuth canonical |
| 55 | VERIFIED | inflight-glob-cleanup-55 | `eaf8b42bb5d1fc194416324606f146196d04c8c0` | No prod inflight; Jest29 glob/inflight dev-only residual classified |
| 56 | VERIFIED | dashboard-bundle-codesplit-56 | `3c4abb74c87467eda7edd0ea396afac59b270262` | Exact-main measurement records a 92.77 KiB entry, zero non-MapLibre chunks over 500 KiB, and exactly one lazy MapLibre vendor at 963.45 KiB raw / 255.71 KiB gzip, within the explicit 1 MiB raw / 300 KiB gzip budget. The budget is enforced by normal dashboard builds and the dedicated exact-SHA Stage 56 workflow. |
| 57 | VERIFIED | dead-code-legacy-cleanup-57 | `bacdf2eb43691ed4553da0f5008f54f94338376a` | Dynamic imports, filesystem command loading, Discord dispatch, AI tools and Nitrado worker registries are included in the deletion-safety analysis; no speculative mass deletion remains. |
| 58 | PARTIAL | full-user-journey | `831e6a374394916440ddcb0fb03ba88dd1327147` | F-S4-10; residual-live-discord-gateway |
| 59 | VERIFIED | chaos | `b3fcb7db4207a9a37b918ef4ba9104fdf070e7e9` | Real PostgreSQL and Redis process kills plus same-client recovery ran twice on isolated PR runners and twice post-merge; circuit, SSRF, path and idempotency fault contracts remain green. |
| 60 | VERIFIED | gesamtaudit-60-code | `d999e90e18d916296ec3657210449480c3349b84` | Executable architecture proof is complete; the dynamic-import/orphan graph is explicitly owned and completed by Stage 61. |
| 61 | VERIFIED | gesamtaudit-61-couplings | `d68a303a5429e8680361a08eccc01dacb2baaf14` | The AST runtime graph covers static, export-from, literal import/require and filesystem-loaded command roots; all production Discord event handlers are reachable and unresolved/dynamic edges fail closed. |
| 62 | PARTIAL | gesamtaudit-62-prod-reality | `831e6a374394916440ddcb0fb03ba88dd1327147` | live-production-deploy-stage-67; live-backup-restore-requires-authorized-staging |
| 63 | PARTIAL | release-sha | — | release-freeze-required-after-final-internal-change |
| 64 | PARTIAL | final-gate-1 | — | final-gate-1-required-on-next-frozen-sha |
| 65 | PARTIAL | final-gate-2 | — | final-gate-2-required-on-next-frozen-sha |
| 66 | PARTIAL | main-gate | — | main-gate-required-after-next-release-freeze-merge |
| 67 | BLOCKED | production-live | — | F-S4-15; stage-42-live-production-network-egress-validation |

## Remaining residuals (priority order)

- Stage 58 (PARTIAL): F-S4-10; residual-live-discord-gateway
- Stage 62 (PARTIAL): live-production-deploy-stage-67; live-backup-restore-requires-authorized-staging
- Stage 63 (PARTIAL): release-freeze-required-after-final-internal-change
- Stage 64 (PARTIAL): final-gate-1-required-on-next-frozen-sha
- Stage 65 (PARTIAL): final-gate-2-required-on-next-frozen-sha
- Stage 66 (PARTIAL): main-gate-required-after-next-release-freeze-merge
- Stage 67 (BLOCKED): F-S4-15; stage-42-live-production-network-egress-validation

## Integrity contract

- `VERIFIED + PARTIAL + FAILED + BLOCKED = 67`.
- Every non-VERIFIED stage names at least one residual/finding.
- A VERIFIED stage cannot retain findings.
- JSON, CSV, and Markdown outputs are UTF-8 without BOM and use LF line endings.
- `npm run audit:check` fails on drift instead of silently regenerating in CI.
