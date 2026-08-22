/**
 * Prometheus-Metriken fuer V-Bot Prime.
 *
 * Der Registry-Code sammelt Default- und Custom-Metriken. Ob GET /metrics
 * tatsaechlich exponiert wird, entscheidet die Dashboard-Konfiguration:
 * METRICS_ENABLED muss explizit aktiviert sein UND ein gueltiger
 * METRICS_TOKEN muss vorhanden sein. Der Endpoint ist Bearer-geschuetzt.
 */

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: 'vbot_' });

export const commandCounter = new Counter({
  name: 'vbot_commands_total',
  help: 'Anzahl ausgefuehrter Slash-Commands',
  labelNames: ['command', 'status'] as const,
  registers: [metricsRegistry],
});

export const commandDurationHistogram = new Histogram({
  name: 'vbot_command_duration_seconds',
  help: 'Ausfuehrungsdauer der Slash-Commands in Sekunden',
  labelNames: ['command'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [metricsRegistry],
});

export const errorCounter = new Counter({
  name: 'vbot_errors_total',
  help: 'Anzahl Fehler nach Quelle',
  labelNames: ['source'] as const,
  registers: [metricsRegistry],
});

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

/**
 * Discord-1: bewusst niedrig-kardinale Gateway-Lifecycle-Ereignisse.
 * Shard-/Guild-/User-IDs werden niemals als Prometheus-Label verwendet.
 */
export const discordGatewayEventCounter = new Counter({
  name: 'vbot_discord_gateway_events_total',
  help: 'Discord Gateway Lifecycle- und Client-Ereignisse nach festem Ereignistyp',
  labelNames: ['event'] as const,
  registers: [metricsRegistry],
});

export const dbQueryHistogram = new Histogram({
  name: 'vbot_db_query_duration_seconds',
  help: 'Prisma-DB-Query-Dauer in Sekunden',
  labelNames: ['model', 'action'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

export const nitradoJobQueueDepthGauge = new Gauge({
  name: 'vbot_nitrado_job_queue_depth',
  help: 'Persistierte Nitrado-Outbox-Jobs nach festem Status',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

export const nitradoJobOldestPendingAgeGauge = new Gauge({
  name: 'vbot_nitrado_job_oldest_pending_age_seconds',
  help: 'Alter des aeltesten noch nicht abgeschlossenen Nitrado-Outbox-Jobs in Sekunden',
  registers: [metricsRegistry],
});

export const nitradoJobWorkerInFlightGauge = new Gauge({
  name: 'vbot_nitrado_job_worker_in_flight',
  help: 'Anzahl aktuell als RUNNING persistierter Nitrado-Outbox-Jobs',
  registers: [metricsRegistry],
});

export type NitradoJobMetricStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'DEAD';

/** Schreibt einen vollstaendigen, niedrig-kardinalen Queue-Snapshot. */
export function setNitradoJobQueueMetrics(
  depths: Partial<Record<NitradoJobMetricStatus, number>>,
  oldestPendingAgeSeconds: number,
): void {
  for (const status of ['PENDING', 'RUNNING', 'DONE', 'FAILED', 'DEAD'] as const) {
    nitradoJobQueueDepthGauge.set({ status }, Math.max(0, depths[status] ?? 0));
  }
  nitradoJobOldestPendingAgeGauge.set(Math.max(0, oldestPendingAgeSeconds));
  nitradoJobWorkerInFlightGauge.set(Math.max(0, depths.RUNNING ?? 0));
}

export const rateLimitedCounter = new Counter({
  name: 'vbot_rate_limited_total',
  help: 'Anzahl Rate-Limit-Treffer',
  labelNames: ['kind'] as const,
  registers: [metricsRegistry],
});

/**
 * AI-20: Nur bewusst niedrig-kardinale Labels. Niemals Discord-/Guild-IDs,
 * Prompts, Antworten oder sourceRef als Prometheus-Label verwenden.
 */
export const aiProviderAttemptsCounter = new Counter({
  name: 'vbot_ai_provider_attempts_total',
  help: 'Persistierte AI-Provider-Call-Ergebnisse nach Provider, Modell und Ergebnis',
  labelNames: ['provider', 'model', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const aiProviderLatencyHistogram = new Histogram({
  name: 'vbot_ai_provider_latency_seconds',
  help: 'Gemessene Latenz persistierter AI-Provider-Call-Ergebnisse in Sekunden',
  labelNames: ['provider', 'model', 'outcome'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30],
  registers: [metricsRegistry],
});

export const aiFallbackCounter = new Counter({
  name: 'vbot_ai_provider_fallback_total',
  help: 'Provider-Ergebnisse, nach denen die Runtime den aktuellen Provider verlaesst',
  labelNames: ['from_provider', 'reason'] as const,
  registers: [metricsRegistry],
});

export const aiRetrievalCounter = new Counter({
  name: 'vbot_ai_retrieval_total',
  help: 'AI-Knowledge-Retrieval nach Strategie und Ergebnis',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [metricsRegistry],
});

export const aiRetrievalDurationHistogram = new Histogram({
  name: 'vbot_ai_retrieval_duration_seconds',
  help: 'Dauer des AI-Knowledge-Retrievals',
  labelNames: ['strategy', 'outcome'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

export const aiRetrievalCandidatesHistogram = new Histogram({
  name: 'vbot_ai_retrieval_candidates',
  help: 'Kandidatenanzahl je Retrieval-Stufe, sofern der jeweilige Caller sie exakt kennt',
  labelNames: ['stage'] as const,
  buckets: [0, 1, 2, 3, 5, 10, 25, 50, 100, 250, 500],
  registers: [metricsRegistry],
});

export const aiKnowledgeSourceCounter = new Counter({
  name: 'vbot_ai_knowledge_sources_total',
  help: 'Tatsaechlich verwendete Knowledge-Quellen nach Typ, Trust, Freshness und Consumer',
  labelNames: ['source_kind', 'trust_level', 'freshness', 'consumer'] as const,
  registers: [metricsRegistry],
});

export const aiKnowledgeSourceAgeHistogram = new Histogram({
  name: 'vbot_ai_knowledge_source_age_days',
  help: 'Alter tatsaechlich verwendeter AI-Knowledge-Quellen in Tagen',
  labelNames: ['source_kind', 'freshness', 'consumer'] as const,
  buckets: [0, 0.01, 0.1, 1, 3, 7, 14, 30, 90, 180, 365, 730],
  registers: [metricsRegistry],
});

/** Misst die Dauer eines async-Calls und schreibt sie in ein Histogramm. */
export async function timed<T>(hist: Histogram<string>, labels: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const end = hist.startTimer(labels);
  try {
    return await fn();
  } finally {
    end();
  }
}
