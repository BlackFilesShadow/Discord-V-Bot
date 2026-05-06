# Monitoring — V-Bot Prime

> Alle exportierten Metriken, Setup-Anleitung und Alerting-Regeln.
> Endpoint: `GET /metrics` (Bearer-Auth via `METRICS_BEARER_TOKEN`).

---

## Exportierte Metriken (`vbot_*`)

| Metric                              | Type      | Labels                  | Bedeutung                                        |
|-------------------------------------|-----------|-------------------------|--------------------------------------------------|
| `vbot_commands_total`               | Counter   | command, status         | Slash-Command-Aufrufe nach Status                |
| `vbot_command_duration_seconds`     | Histogram | command                 | Command-Laufzeiten (Buckets 0.01–5s)             |
| `vbot_errors_total`                 | Counter   | source                  | Fehler nach Quelle (command/dashboard/ai/db/…)   |
| `vbot_guilds`                       | Gauge     | —                       | Anzahl Guilds (live)                             |
| `vbot_discord_ws_latency_ms`        | Gauge     | —                       | Discord-WebSocket-Latenz                         |
| `vbot_db_query_duration_seconds`    | Histogram | op                      | Prisma-Query-Latenz pro Operation                |
| `vbot_rate_limited_total`           | Counter   | kind                    | Rate-Limit-Treffer (in_memory/per_command/cooldown) |

Plus `process_*`/`nodejs_*`-Default-Metriken von `prom-client`.

---

## Prometheus-Setup

### Scrape-Konfig

```yaml
scrape_configs:
  - job_name: vbot
    metrics_path: /metrics
    scheme: https
    static_configs:
      - targets: ['<dein-host>:443']
    bearer_token: '<METRICS_BEARER_TOKEN>'
    scrape_interval: 30s
    scrape_timeout: 10s
```

### Alerting

Die Datei [`prometheus-alerts.yml`](prometheus-alerts.yml) enthält 7 Regeln in
3 Gruppen (`vbot.critical`, `vbot.performance`, `vbot.fleet`).

In `prometheus.yml`:

```yaml
rule_files:
  - /etc/prometheus/rules/vbot.yml
```

und die Datei nach `/etc/prometheus/rules/vbot.yml` kopieren.

Empfohlener Receiver-Mapping (`alertmanager.yml`):
- `severity: critical` → Discord-Webhook + E-Mail
- `severity: warning` → Discord-Webhook
- `severity: info` → nur Logging

---

## Grafana-Dashboard (Skeleton)

Minimal-Dashboard mit den wichtigsten Panels — als Startpunkt; importierbar
über *Dashboards → New → Import → Paste JSON*.

```json
{
  "title": "V-Bot Overview",
  "schemaVersion": 39,
  "panels": [
    {
      "title": "Commands per Minute",
      "type": "timeseries",
      "targets": [
        { "expr": "sum(rate(vbot_commands_total[1m])) by (status)" }
      ]
    },
    {
      "title": "Command Latency p95",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.95, sum(rate(vbot_command_duration_seconds_bucket[5m])) by (le, command))",
          "legendFormat": "{{ command }}"
        }
      ]
    },
    {
      "title": "Errors / sec by Source",
      "type": "timeseries",
      "targets": [
        { "expr": "sum(rate(vbot_errors_total[5m])) by (source)" }
      ]
    },
    {
      "title": "DB Query p99",
      "type": "timeseries",
      "targets": [
        {
          "expr": "histogram_quantile(0.99, sum(rate(vbot_db_query_duration_seconds_bucket[5m])) by (le, op))",
          "legendFormat": "{{ op }}"
        }
      ]
    },
    {
      "title": "Discord WS Latency",
      "type": "stat",
      "targets": [{ "expr": "vbot_discord_ws_latency_ms" }],
      "fieldConfig": { "defaults": { "unit": "ms" } }
    },
    {
      "title": "Guilds",
      "type": "stat",
      "targets": [{ "expr": "vbot_guilds" }]
    },
    {
      "title": "Rate-Limit Hits",
      "type": "timeseries",
      "targets": [
        { "expr": "sum(rate(vbot_rate_limited_total[5m])) by (kind)" }
      ]
    }
  ]
}
```

---

## Error-Sink (Discord-Webhook)

Zusätzlich zu Prometheus: kritische Fehler pushen an `ERROR_WEBHOOK_URL`
(Discord-Webhook). Implementierung in [`src/utils/errorSink.ts`](../../src/utils/errorSink.ts).

- **Throttling**: 1 Push pro Fehler-Signature je 5 min (verhindert Flood)
- **Retention**: max 1000 Signaturen, LRU-Eviction
- **Felder**: source, host, command, userId, guildId, stack (max 6 Frames)
- **Fail-Safe**: Webhook-Fehler werden geschluckt — keine App-Disruption
