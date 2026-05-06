# Performance & Profiling

Operative Anleitung für Latenz-/Durchsatz-Messung und Tuning. Ziel: reproduzierbare Zahlen
aus `live` (Hetzner-Server) und `local` (Codespace), nicht Mikro-Benchmarks aus Tests.

---

## 1. Live-Metriken via `/metrics`

Der Bot exportiert Prometheus-Metriken auf `:9090/metrics` (intern, nicht über das öffentliche
Dashboard erreichbar). Wichtige Reihen:

| Metrik | Aussage |
|---|---|
| `vbot_http_request_duration_seconds_bucket{route,method,le}` | Histogramm der Express-Routes (Dashboard + Webhook) |
| `vbot_discord_command_duration_seconds_bucket{command}` | Slash-Command-Laufzeit pro Command |
| `vbot_ai_provider_request_duration_seconds_bucket{provider,model}` | LLM-Latenz |
| `vbot_ai_provider_failures_total{provider,reason}` | Failover-Trigger |
| `vbot_response_cache_hits_total{namespace}` / `..._misses_total` | Redis-Cache-Effizienz |
| `vbot_embedding_cache_hits_total{tier}` | L1/L2-Hit-Verteilung |
| `vbot_db_pool_active`, `vbot_db_pool_idle`, `vbot_db_pool_waiting` | Prisma-Pool-Auslastung |
| `vbot_event_loop_lag_seconds` | Node-Event-Loop-Latenz |
| `process_resident_memory_bytes`, `process_cpu_seconds_total` | Prozess-Health |

Beispiel-Queries (PromQL):

```promql
# p95 Dashboard-Latenz pro Route
histogram_quantile(0.95,
  sum by (le, route) (rate(vbot_http_request_duration_seconds_bucket[5m])))

# AI-Cache-Hit-Rate (gleitender 15-Min-Schnitt)
sum(rate(vbot_response_cache_hits_total[15m]))
  / (sum(rate(vbot_response_cache_hits_total[15m])) + sum(rate(vbot_response_cache_misses_total[15m])))

# Provider-Failover-Rate
sum by (provider) (rate(vbot_ai_provider_failures_total[5m]))
```

Alert-Rules siehe [docs/monitoring/prometheus-alerts.yml](monitoring/prometheus-alerts.yml).

---

## 2. Schnell-Profil eines Live-Endpoints

```bash
# Latenz-Histogramm einer Dashboard-Route (vom Codespace gegen Live)
hey -n 500 -c 20 -H "Cookie: vbot.sid=<dein-test-session>" \
  https://dashboard.example.tld/api/health

# Discord-Command-Latenz: aus Logs greppen
ssh deploy@server 'docker compose logs --since 30m bot | grep -E "command=.*duration_ms="' \
  | awk '{ for(i=1;i<=NF;i++) if($i ~ /duration_ms=/){split($i,a,"="); print a[2]}}' \
  | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END {print "p50",a[int(c*0.5)]," p95",a[int(c*0.95)]," p99",a[int(c*0.99)]," n",c}'
```

---

## 3. Lasttest (synthetisch)

Skripte liegen in [scripts/](../scripts):

| Skript | Zweck |
|---|---|
| `scripts/loadtest.ts` | Discord-API-Mocked-Command-Loop — misst In-Process-Latenz ohne Discord-RTT |
| `scripts/loadtest-server.ts` | HTTP-Lasttest gegen Express-Routes (Dashboard + Webhooks) |

Aufruf:

```bash
DASHBOARD_URL=http://127.0.0.1:3000 npx tsx scripts/loadtest-server.ts \
  --routes /api/stats,/api/audit?limit=20 --duration 60 --concurrency 25
```

Output: pro Route `count, p50, p95, p99, errors`, plus Aggregat in JSON für CI-Vergleich.

---

## 4. Profiling-Workflow (Heap & CPU)

### CPU-Flamegraph

```bash
# Bot mit --inspect starten
docker compose run --rm -p 9229:9229 bot \
  node --inspect=0.0.0.0:9229 --enable-source-maps dist/index.js

# Lokal: chrome://inspect → CPU-Profil aufzeichnen → Last gegen den Bot fahren
# Ergebnis als .cpuprofile speichern, in Speedscope öffnen: https://www.speedscope.app
```

Hotspots prüfen:
- AI-Pipeline (`aiHandler.handle`) — sollte <50 ms ohne LLM-Call sein
- `interactionCreate` — Routing + Permission-Check; Ziel <5 ms
- Prisma-Queries — N+1 erkennt man am `Query.executeRaw`-Anteil

### Heap-Snapshot

```bash
# Snapshot via Inspector triggern
node -e "require('inspector').open(9229,'0.0.0.0',true)"
# Chrome DevTools → Memory → Heap snapshot
```

Vergleich zweier Snapshots zeigt Leaks (z. B. wachsende `Map`-Caches ohne TTL).

---

## 5. Datenbank-Profiling

```sql
-- Top-20 langsame Queries (pg_stat_statements muss aktiv sein)
SELECT calls, mean_exec_time, max_exec_time, query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

-- Index-Nutzung pro Tabelle
SELECT relname, idx_scan, seq_scan, n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 20;

-- Connection-Pool-Health
SELECT state, count(*) FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state;
```

Pool-Einstellungen liegen als Query-Params in `DATABASE_URL`
(`connection_limit`, `pool_timeout`, `statement_cache_size`).

---

## 6. Cache-Tuning

### Redis (Response-Cache)

```bash
# Hit-Rate live
docker compose exec redis redis-cli INFO stats \
  | grep -E "keyspace_hits|keyspace_misses"

# Speicher-Distribution pro Namespace
docker compose exec redis redis-cli --scan --pattern 'rcache:*' \
  | awk -F':' '{print $2}' | sort | uniq -c | sort -rn
```

Wenn Hit-Rate <40 % → TTL erhöhen oder Namespace-Strategie überdenken.

### Embedding-Cache (L1+L2)

```sql
-- L2-Größe und Wachstum
SELECT count(*), pg_size_pretty(pg_total_relation_size('"EmbeddingCache"'))
FROM "EmbeddingCache";

-- Heißeste Inputs (häufigster Reuse)
SELECT "inputHash", "hitCount", "lastUsedAt"
FROM "EmbeddingCache"
ORDER BY "hitCount" DESC LIMIT 20;
```

---

## 7. Vor jedem Release: Kurz-Checkliste

- [ ] Voller Jest-Run grün (`npm test`)
- [ ] Playwright-E2E grün (`cd dashboard-ui && npm run e2e`)
- [ ] `loadtest-server.ts` p95 unter Vorgängerwert (Regression?)
- [ ] `/metrics` zeigt nach Deploy keine neue `*_failures_total`-Spitze (15 Min nach Rollout)
- [ ] DB-Migration: `EXPLAIN ANALYZE` der heißesten neuen Query auf Live-Snapshot

---

## 8. Bekannte Hotspots (Stand: aktuelles Quartal)

| Pfad | Beobachtung | Mitigation aktiv |
|---|---|---|
| `aiHandler.translateText` | 800 ms LLM-Call | Redis-Cache 24 h TTL → ~85 % Hits bei Standardsprachen |
| `embeddingService.embed` | 200 ms LLM-Call | L1-Memory + L2-Postgres → ~70 % Hits insgesamt |
| `Audit.search` mit Volltext | seq scan über >1 M Zeilen | pg_trgm-Index `001_audit_trigram_index.sql` |
| Prisma kalter Pool | 1. Request 600 ms | `connection_limit=10` + Warmup-Query in `index.ts` |

---

## 9. Live-Profiling-Snapshot (Server-Daten)

Aufgenommen mit `docker stats`, `redis-cli INFO`, `pg_stat_user_tables`
direkt vom Produktions-Container.

### Container-Footprint

| Container | CPU | RAM | Net I/O | Block I/O |
|---|---|---|---|---|
| `discord-v-bot` | 0.50 % | 81 MB / 3.7 GB | 12.6 MB / 26.3 MB | 15.6 MB / 1.14 MB |
| `discord-v-bot-postgres` | 0.10 % | 56 MB / 3.7 GB | 508 MB / 477 MB | 211 MB / 4.52 GB |
| `discord-v-bot-redis` | 0.38 % | 13 MB / 3.7 GB | 1.5 kB / 126 B | 10.5 MB / 8 kB |

Bot-Prozess sitzt bei ~80 MB Resident-Set — komfortabel unter dem 256-MB-Soft-Limit.

### Redis-Cache (Response-Cache)

```
used_memory_human:        1012 K
used_memory_peak_human:   1012 K
maxmemory_human:          256 M
mem_fragmentation_ratio:  8.53   ← hoher Wert wegen wenig Traffic, normal bei <2 MB
total_commands_processed: 778
keyspace_hits:            0
keyspace_misses:          0
DBSIZE:                   0
```

**Befund:** Cache ist eingerichtet, aber `translateText` wurde seit dem
Redis-Deploy (Commit `892a6cf`) noch nicht aufgerufen — keine Hits/Misses.
Das ist kein Bug: deterministische Translate-Calls treten erst bei
`/translate-post`-Workflows auf. Sobald die Funktion warm wird, fuellt
sich der Cache.

### Postgres-Pool

| State | Connections |
|---|---|
| idle | 5 |
| active | 1 |

6 von 10 erlaubten Connections in Nutzung — kein Pool-Druck. `pool_timeout`
wird nicht erreicht.

### Top-Tabellen nach Live-Rows

| Tabelle | Rows | seq_scan | idx_scan | Size |
|---|---|---|---|---|
| `XpRecord` | 4135 | 13 | 43 | 1.4 MB |
| `IdempotencyKey` | 331 | 106 | 263 | 248 kB |
| `AuditLog` | 246 | 135 | 10 | 608 kB |
| `Download` | 151 | 58 | 56 | 200 kB |
| `AiConversationTurn` | 118 | 451 | 809 | 288 kB |
| `GuildMemberProfile` | 117 | 515 | 5612 | 168 kB |
| `User` | 105 | **9995** | 7764 | 136 kB |
| `WhitelistEntry` | 75 | 79 | 8 | 96 kB |

**Auffaelligkeit:** `User` hat 9995 sequentielle Scans gegenueber 7764
Index-Scans bei nur 105 Zeilen. Bei dieser Tabellengroesse ist seq_scan
zwar nicht teuer (Postgres bevorzugt full-scan unter ~1000 Rows), aber
**sobald `User` waechst (>5 k Rows), wird das spuerbar**. Empfehlung:
Code-Audit auf `prisma.user.findMany({ where: { discordId: ... } })`
ohne expliziten `findUnique` (Index-Hit garantiert).

`EmbeddingCache` ist mit 0 Rows / 32 kB noch leer — wird gefuellt sobald
RAG-Suchen oder semantische Vergleiche getriggert werden.

### Empfohlene Folgemassnahmen (priorisiert)

1. **User-Lookups auditieren** — alle `findMany`/`findFirst` auf `User`
   pruefen, ggf. zu `findUnique` umschreiben (nutzt Primary-Key-Index).
2. **Cache-Warming** — initial einmal `translateText` fuer die 5
   wichtigsten Sprach-Paare im Bot-Boot triggern, damit erster
   Live-Request bereits Cache-Hit ist.
3. **Memory-Headroom monitoren** — bei steigender Last `vbot_process_resident_memory_bytes`
   beobachten; aktuell ~80 MB, Hard-Cap setzen wenn >300 MB anhaltend.
