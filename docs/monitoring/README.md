# Monitoring — V-Bot Prime

> Aktueller Prometheus-/Alerting-Stand.

## Aktivierung und Zugriff

`GET /metrics` ist **optional** und nur verfügbar, wenn:

- `METRICS_ENABLED=true` gesetzt ist und
- `METRICS_TOKEN` ausreichend lang konfiguriert ist.

Der Endpoint ist Bearer-geschützt. Ohne gültigen Bearer-Token werden keine Metriken ausgegeben. Der Deploy-Pfad kann bei aktivierten Metrics einen fehlenden Token sicher lokal erzeugen und in `.env` speichern, ohne ihn im Log anzuzeigen.

Beispiel:

```yaml
scrape_configs:
  - job_name: vbot
    metrics_path: /metrics
    scheme: https
    static_configs:
      - targets: ['<dein-host>:443']
    authorization:
      type: Bearer
      credentials: '<METRICS_TOKEN>'
    scrape_interval: 30s
    scrape_timeout: 10s
```

`<METRICS_TOKEN>` steht hier nur als Platzhalter. Niemals den echten Token in Repository, Screenshots oder Logs übernehmen.

---

## Exportierte Metriken (`vbot_*`)

| Metrik | Typ | Labels | Bedeutung |
|---|---|---|---|
| `vbot_commands_total` | Counter | `command`, `status` | ausgeführte Discord-Slash-Commands nach Status |
| `vbot_command_duration_seconds` | Histogram | `command` | Command-Laufzeiten |
| `vbot_errors_total` | Counter | `source` | Fehler nach Quelle |
| `vbot_guilds` | Gauge | — | aktuell verbundene Discord-Guilds |
| `vbot_discord_ws_latency_ms` | Gauge | — | Discord-WebSocket-Latenz |
| `vbot_db_query_duration_seconds` | Histogram | `model`, `action` | Prisma-Query-Latenz pro Modell/Aktion |
| `vbot_rate_limited_total` | Counter | `kind` | Rate-Limit-/Cooldown-Treffer |

Zusätzlich registriert `prom-client` Node-/Process-Default-Metriken mit `vbot_`-Prefix.

Die Command-Metriken messen **tatsächlich geladene Discord-Commands**. Globale Bot-Admin-/DEV-Verwaltung ist Dashboard-only und taucht deshalb nicht als ehemaliger privilegierter Slash-Command in diesen Reihen auf.

---

## Beispiel-PromQL

```promql
# Command-Rate nach Status
sum(rate(vbot_commands_total[5m])) by (status)

# p95 Command-Latenz
histogram_quantile(
  0.95,
  sum(rate(vbot_command_duration_seconds_bucket[5m])) by (le, command)
)

# Fehler nach Quelle
sum(rate(vbot_errors_total[5m])) by (source)

# p99 DB-Latenz nach Prisma-Modell/Aktion
histogram_quantile(
  0.99,
  sum(rate(vbot_db_query_duration_seconds_bucket[5m])) by (le, model, action)
)

# Discord-Gateway-Latenz
vbot_discord_ws_latency_ms

# Rate-Limit-Hits
sum(rate(vbot_rate_limited_total[5m])) by (kind)
```

---

## Alerting

`prometheus-alerts.yml` enthält die Repository-Alertregeln. Vor produktiver Nutzung immer gegen die tatsächlich exportierten Metric-Namen/Labels aus `/metrics` validieren.

Empfohlene Severity-Zuordnung:

- `critical` → unmittelbare Alarmierung,
- `warning` → Betriebswarnung,
- `info` → Logging/Beobachtung.

---

## Grafana-Grundpanels

Sinnvolle Panels:

- Commands/min nach Status,
- Command p95 nach `command`,
- Errors/sec nach `source`,
- DB p95/p99 nach `model` + `action`,
- Discord WS-Latenz,
- Guild-Anzahl,
- Rate-Limit-Hits nach `kind`,
- Node-/Process-RAM und CPU.

Die Dashboard-Abfragen sollten direkt gegen den aktuell laufenden `/metrics`-Output geprüft werden; fest gespeicherte Beispielwerte sind keine Laufzeit-Wahrheit.

---

## Error-Sink

Zusätzlich zu Prometheus können kritische Fehler über `ERROR_WEBHOOK_URL` an einen Discord-Webhook gemeldet werden. Die Implementierung liegt in `src/utils/errorSink.ts`.

Schutzmechanismen:

- Throttling pro Fehler-Signatur,
- begrenzte Signatur-Retention,
- Fail-Safe bei Webhook-Fehlern,
- keine absichtliche Weitergabe von Secrets/DEV-ReAuth-Credentials.

---

## Prüfung nach Deploy

Wenn Metrics aktiviert sein sollen:

1. sicherstellen, dass `METRICS_ENABLED=true` gesetzt ist,
2. sicherstellen, dass ein ausreichend langer `METRICS_TOKEN` existiert,
3. Request ohne Bearer-Token muss abgewiesen werden,
4. Request mit gültigem Token muss Prometheus-Text liefern,
5. Metric-Namen und Labels gegen diese Datei und `src/utils/metrics.ts` prüfen,
6. Token niemals ausgeben oder in Support-Logs kopieren.
