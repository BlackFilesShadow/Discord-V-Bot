# Architecture — V-Bot Prime

> High-Level-Übersicht des Systems. Für tiefe Modul-Details siehe Inline-JSDoc.

---

## Top-Level

```
┌─────────────────┐         ┌──────────────────────────────────┐
│   Discord API   │◄───────►│  Bot-Process (src/index.ts)      │
└─────────────────┘  WS+REST│  - Slash-Commands (commands/)    │
                            │  - Events (events/)              │
                            │  - Module (modules/)             │
                            │    XP, Tickets, Whitelist, AI,   │
                            │    Killfeed, Translate, RAG, ... │
                            └────────┬─────────────────────────┘
                                     │
                                     ▼
                            ┌──────────────────┐
                            │  PostgreSQL 16   │
                            │  + pgvector      │
                            │  (Prisma-ORM)    │
                            └────────▲─────────┘
                                     │
┌──────────────────┐                 │
│ Dashboard-UI     │  HTTP/WS        │
│ (Vite + React)   │◄────────────────┤
└──────────────────┘                 │
                            ┌────────┴─────────────────────────┐
                            │  Dashboard-Server                │
                            │  (src/dashboard/server.ts)       │
                            │  - Express + Helmet + CSP        │
                            │  - OAuth2 + Session(PG-Store)    │
                            │  - REST (/api, /api/v2)          │
                            │  - Socket.io (Live-Updates)      │
                            │  - Webhooks (HMAC)               │
                            └──────────────────────────────────┘
```

---

## Verzeichnis-Struktur (Top-Level)

| Pfad             | Zweck                                                            |
|------------------|------------------------------------------------------------------|
| `src/commands/`  | Slash-Commands (eine Datei = ein Command)                        |
| `src/events/`    | Discord-Gateway-Event-Handler                                    |
| `src/modules/`   | Domain-Logik, geteilt zwischen Commands+Events                   |
| `src/dashboard/` | Web-Dashboard (Express + Routes + Services)                      |
| `src/database/`  | Prisma-Client + DB-Helper                                        |
| `src/utils/`     | Stateless-Helfer (Logger, Validator, EmbedSanitize, Metrics)     |
| `src/scripts/`   | Maintenance-Skripte (one-shot)                                   |
| `prisma/`        | Schema + Migrationen                                             |
| `dashboard-ui/`  | Vite-React-Frontend (separates Build-Target)                     |
| `deploy/`        | Server-Side-Skripte (`bot.sh`, `update.sh`, `backup.sh`, …)      |
| `tests/`         | Jest-Tests (Spiegelung der `src/`-Struktur)                      |
| `eslint-rules/`  | Custom ESLint-Rules (z.B. `no-unscoped-prisma-query`)            |

---

## Datenfluss-Beispiele

### Slash-Command-Lebenszyklus
1. User tippt `/befehl`
2. Discord-Gateway → `events/interactionCreate.ts`
3. Dispatcher findet Command-File in `commands/`
4. Permission-Check (`requirePermission`)
5. Handler-Logik (DB-Query via Prisma, ggf. AI-Call)
6. User-Content für Embed → `safeEmbedField`
7. Reply via `interaction.reply` oder `editReply`
8. Action-Audit-Trail (DB-Insert)

### Dashboard-API-Request
1. Browser → Caddy/nginx (TLS-Termination, HTTP→HTTPS)
2. Reverse-Proxy → Express
3. Helmet/CSP/Permissions-Policy headers
4. Session-Lookup (PG-Store)
5. Route-Handler mit `requireAuth` / `requireDev`
6. Bei `/api/v2/dev/*`: zusätzlich MFA + IP-Allowlist
7. Prisma-Query → Response (JSON)
8. SecurityEvent-Log bei sensiblen Aktionen

### Webhook-Empfang
1. Externer Sender → POST `/webhooks/<provider>`
2. Raw-Body-Parser (Signatur braucht ungeparsten Body)
3. HMAC-SHA256 Vergleich (Constant-Time)
4. Replay-Schutz via Timestamp-Window
5. Domain-Logik dispatcht an passendes Modul

---

## Wichtige Architektur-Prinzipien

### Multi-Tenancy / Guild-Scoping
- Jede Tabelle, die Guild-bezogene Daten hält, **muss** `guildId` als Spalte haben
- Jede Query auf solche Tabellen **muss** nach `guildId` filtern
- ESLint-Rule [`eslint-rules/no-unscoped-prisma-query.js`](eslint-rules/no-unscoped-prisma-query.js) erzwingt das

### Defense-in-depth
- Auth-Layer ist nie Single-Point-of-Failure
- Beispiel Dev-Dashboard: Session → Role → DevSession → MFA → IP (5 Gates)

### Multi-Provider-Failover (AI)
- 5 AI-Provider in Reihe: Cerebras → OpenRouter → Groq → Gemini → OpenAI
- Health-Stats pro Provider in `aiProviderStats`-Tabelle
- Automatisches Re-Routing bei Quota/Error/Latenz

### Backup & Recovery
- Tägliches `pg_dump` via `deploy/backup.sh`
- Verifizierung via `deploy/backup-verify.sh` (Restore in Throwaway-DB)
- Backup-Retention: 30 Tage rolling

---

## Ports & Prozesse (Production)

| Prozess          | Port  | Rolle                                    |
|------------------|-------|------------------------------------------|
| `bot.ts`         | —     | Discord-Gateway, kein offener Port       |
| `dashboard`      | 3000  | Express, hinter Reverse-Proxy            |
| `postgres`       | 5432  | Nur localhost-bound im Compose           |
| `caddy`/`nginx`  | 443   | TLS-Termination, HTTP→HTTPS-Redirect     |

---

## Observability

- **Logs**: strukturiertes JSON via `src/utils/logger.ts`, PII-Redactor aktiv
- **Metrics**: Prometheus-kompatibler Endpoint `/metrics` (Bearer-Token)
- **Health**: `/api/health` ohne Auth (Liveness)
- **Error-Sink**: kritische Fehler → Discord-Webhook (optional konfigurierbar)
- **Latency-Tracking**: `attachPrismaLatencyMiddleware` instrumentiert alle DB-Calls

---

## Erweitern: neues Modul anlegen

1. Ordner in `src/modules/<feature>/`
2. Falls Persistenz nötig: Prisma-Schema-Update + Migration
3. Falls Slash-Command: Datei in `src/commands/<gruppe>/`
4. Falls Dashboard-Endpunkt: Router in `src/dashboard/routes/v2/`
5. Tests in `tests/<bereich>/`
6. Doku im Modul-Top-Kommentar
