/**
 * Prometheus-Metriken für den Discord-V-Bot.
 *
 * Exponiert über GET /metrics auf dem Dashboard-Server.
 * Default-Metriken (Process-CPU/Mem/EventLoop) sind aktiv,
 * dazu Custom-Counter/Histograms für Commands, Errors, DB-Queries.
 *
 * Token-geschützt via METRICS_TOKEN env, falls gesetzt.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

// Default Node.js-Process-Metriken
collectDefaultMetrics({ register: metricsRegistry, prefix: 'vbot_' });

// ─── Slash-Commands ──────────────────────────────────────────
export const commandCounter = new Counter({
  name: 'vbot_commands_total',
  help: 'Anzahl ausgefuehrter Slash-Commands',
  labelNames: ['command', 'status'] as const, // status: success | error | denied | cooldown | ratelimit
  registers: [metricsRegistry],
});

export const commandDurationHistogram = new Histogram({
  name: 'vbot_command_duration_seconds',
  help: 'Ausfuehrungsdauer der Slash-Commands in Sekunden',
  labelNames: ['command'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

// ─── Errors ──────────────────────────────────────────────────
export const errorCounter = new Counter({
  name: 'vbot_errors_total',
  help: 'Anzahl Fehler nach Quelle',
  labelNames: ['source'] as const, // source: command | dashboard | event | ai | db | other
  registers: [metricsRegistry],
});

// ─── Discord-Connection ──────────────────────────────────────
export const guildGauge = new Gauge({
  name: 'vbot_guilds',
  help: 'Anzahl verbundener Discord-Guilds',
  registers: [metricsRegistry],
});

export const wsLatencyGauge = new Gauge({
  name: 'vbot_discord_ws_latency_ms',
  help: 'Discord-Gateway-WebSocket-Latenz in ms',
  registers: [metricsRegistry],
});

// ─── DB-Performance ──────────────────────────────────────────
export const dbQueryHistogram = new Histogram({
  name: 'vbot_db_query_duration_seconds',
  help: 'Prisma-DB-Query-Dauer in Sekunden',
  labelNames: ['model', 'action'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

// ─── Rate-Limiter / Cooldowns ────────────────────────────────
export const rateLimitedCounter = new Counter({
  name: 'vbot_rate_limited_total',
  help: 'Anzahl Rate-Limit-Treffer',
  labelNames: ['kind'] as const, // kind: in_memory | cooldown
  registers: [metricsRegistry],
});

/**
 * Convenience-Helper: misst die Dauer eines async-Calls und schreibt sie in ein Histogram.
 */
export async function timed<T>(hist: Histogram<string>, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const end = hist.startTimer(labels);
  try {
    return await fn();
  } finally {
    end();
  }
}
