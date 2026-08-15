# Performance & Profiling

Operative Anleitung für Latenz-/Durchsatz-Messung und Tuning. Ziel: reproduzierbare Zahlen aus Produktion und lokaler Entwicklung, nicht Mikro-Benchmarks aus isolierten Tests.

---

## 1. Live-Metriken via `/metrics`

Prometheus-Metriken sind **optional**. Der Endpoint wird nur aktiviert, wenn `METRICS_ENABLED=true` angefordert wurde und ein ausreichend langer `METRICS_TOKEN` vorhanden ist. Der Zugriff ist Bearer-geschützt; der Token darf weder in Beispielen noch in Logs ausgegeben werden.

Der Deploy-Pfad kann bei aktivierten Metrics einen fehlenden Token sicher lokal erzeugen und in `.env` persistieren. Ist Metrics deaktiviert, bleibt `/metrics` bewusst aus.

Wichtige Reihen bei aktivierten Metrics:

| Metrik | Aussage |
|---|---|
| `vbot_http_request_duration_seconds_bucket{route,method,le}` | Histogramm der Express-Routes (Dashboard + Webhook) |
| `vbot_discord_command_duration_seconds_bucket{command}` | Laufzeit tatsächlich geladener Discord-Commands |
| `vbot_ai_provider_request_duration_seconds_bucket{provider,model}` | LLM-Latenz |
| `vbot_ai_provider_failures_total{provider,reason}` | Failover-Trigger |
| `vbot_response_cache_hits_total{namespace}` / `..._misses_total` | Redis-Cache-Effizienz |
| `vbot_embedding_cache_hits_total{tier}` | L1/L2-Hit-Verteilung |
| `vbot_db_pool_active`, `vbot_db_pool_idle`, `vbot_db_pool_waiting` | Prisma-Pool-Auslastung |
| `vbot_event_loop_lag_seconds` | Node-Event-Loop-Latenz |
| `process_resident_memory_bytes`, `process_cpu_seconds_total` | Prozess-Health |

Beispiel-Queries:

```promql
histogram_quantile(0.95,
  sum by (le, route) (rate(vbot_http_request_duration_seconds_bucket[5m])))

sum(rate(vbot_response_cache_hits_total[15m]))
  / (sum(rate(vbot_response_cache_hits_total[15m])) + sum(rate(vbot_response_cache_misses_total[15m])))

sum by (provider) (rate(vbot_ai_provider_failures_total[5m]))
```

Alert-Rules siehe `docs/monitoring/prometheus-alerts.yml`.

---

## 2. Schnell-Profil eines Live-Endpoints

```bash
# Beispiel: Dashboard-Route gegen eine Test-/Live-Instanz
hey -n 500 -c 20 -H "Cookie: vbot.sid=<test-session>" \
  https://dashboard.example.tld/api/health

# Discord-Command-Latenz aus Logs
ssh deploy@server 'docker compose logs --since 30m bot | grep -E "command=.*duration_ms="' \
  | awk '{ for(i=1;i<=NF;i++) if($i ~ /duration_ms=/){split($i,a,"="); print a[2]}}' \
  | sort -n | awk 'BEGIN{c=0} {a[c++]=$1} END {print "p50",a[int(c*0.5)]," p95",a[int(c*0.95)]," p99",a[int(c*0.99)]," n",c}'
```

---

## 3. Lasttest

Skripte liegen in `scripts/`:

| Skript | Zweck |
|---|---|
| `scripts/loadtest.ts` | Discord-API-Mocked-Command-Loop — misst In-Process-Latenz ohne Discord-RTT |
| `scripts/loadtest-server.ts` | HTTP-Lasttest gegen Express-Routes (Dashboard + Webhooks) |

```bash
DASHBOARD_URL=http://127.0.0.1:3000 npx tsx scripts/loadtest-server.ts \
  --routes /api/stats,/api/audit?limit=20 --duration 60 --concurrency 25
```

Output: pro Route `count, p50, p95, p99, errors`, plus Aggregat in JSON.

---

## 4. Profiling-Workflow

### CPU

```bash
docker compose run --rm -p 9229:9229 bot \
  node --inspect=0.0.0.0:9229 --enable-source-maps dist/index.js
```

Danach über Chrome DevTools/Speedscope profilieren. Typische Hotspots:

- AI-Pipeline ohne externen LLM-Call,
- `interactionCreate` inklusive Permission-/Scope-Checks,
- Dashboard-Routen und Prisma-N+1,
- Nitrado-/ADM-Postprocessing bei größerem Backlog.

### Heap

Heap-Snapshots können im DEV-Dashboard über die geschützten Debug-Tools erzeugt werden. Die Mutation liegt hinter DEV-Identität, DevSession und verifiziertem Step-Up und besitzt Rate-Limiting. Direkte ungeschützte Produktions-Snapshot-Aufrufe sind kein vorgesehener Betriebsweg.

---

## 5. Datenbank-Profiling

```sql
SELECT calls, mean_exec_time, max_exec_time, query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;

SELECT relname, idx_scan, seq_scan, n_live_tup
FROM pg_stat_user_tables
ORDER BY seq_scan DESC
LIMIT 20;

SELECT state, count(*) FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state;
```

Pool-Einstellungen liegen in der `DATABASE_URL` (`connection_limit`, `pool_timeout`, `statement_cache_size`).

---

## 6. Cache-Tuning

### Redis Response-Cache

```bash
docker compose exec redis redis-cli INFO stats \
  | grep -E "keyspace_hits|keyspace_misses"

docker compose exec redis redis-cli --scan --pattern 'rcache:*' \
  | awk -F':' '{print $2}' | sort | uniq -c | sort -rn
```

### Embedding-Cache

```sql
SELECT count(*), pg_size_pretty(pg_total_relation_size('"EmbeddingCache"'))
FROM "EmbeddingCache";

SELECT "inputHash", "hitCount", "lastUsedAt"
FROM "EmbeddingCache"
ORDER BY "hitCount" DESC LIMIT 20;
```

---

## 7. Vor jedem Release

- [ ] Voller Jest-Run grün.
- [ ] Lint + Backend-TypeScript + Frontend-Build grün.
- [ ] Playwright-E2E grün.
- [ ] Prisma Generate/Validate/Migration-Status grün.
- [ ] Security-Audit/SBOM grün.
- [ ] Bei aktivierten Metrics: `/metrics` ohne Bearer-Token nicht zugänglich und mit gültigem Token erreichbar.
- [ ] Nach Deploy keine neue Fehler-/Retry-Spitze in Logs, SecurityEvents oder Nitrado-Outbox.

---

## 8. Aktuelle besondere Lastpfade

| Pfad | Risiko | Aktive Mitigation |
|---|---|---|
| AI-Provider | externe Latenz / 429 / Authfehler | adaptives Provider-Ranking, persistente Cooldowns, Fallback |
| Übersetzungen | wiederholte deterministische AI-Aufrufe | Response-Cache |
| Audit-Volltext | wachsende Logmenge | DB-Indexierung + begrenzte Dashboard-/Exportabfragen |
| DEV-Audit-Export | große Datenmenge | stabile Cursor-Pagination + Hard-Cap 50.000 |
| ADM-V2 | mehrere aktive Gameserver / Logrotation | per-Server Cursor, Seek-basierter Ingest, Postprocess |
| Gameplay-Delivery | Discord-Fehler / großer Backlog | persistente Delivery, Lease, Retry, High-Watermark, Dedupe-Marker |

---

## 9. Historische Live-Snapshots

Konkrete CPU-/RAM-/Tabellenzahlen aus einzelnen Messzeitpunkten sind **Momentaufnahmen** und gehören in separate Incident-/Profiling-Aufzeichnungen. Sie dürfen nicht als aktuelle Produktionswerte in dieser kanonischen Anleitung interpretiert werden.

Für aktuelle Werte immer die laufende DEV-Observability, Datenbankstatistiken, Container-Metriken und — falls aktiviert — den geschützten Prometheus-Endpoint verwenden.
