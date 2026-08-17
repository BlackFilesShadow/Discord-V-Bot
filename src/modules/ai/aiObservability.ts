import {
  aiFallbackCounter,
  aiKnowledgeSourceAgeHistogram,
  aiKnowledgeSourceCounter,
  aiProviderAttemptsCounter,
  aiProviderLatencyHistogram,
  aiRetrievalCandidatesHistogram,
  aiRetrievalCounter,
  aiRetrievalDurationHistogram,
} from '../../utils/metrics';
import type { ProviderName } from './providerStats';
import type {
  KnowledgeFreshness,
  KnowledgeSourceKind,
  KnowledgeTrustLevel,
} from './knowledgeProvenance';

export type AiProviderOutcome = 'success' | 'failure' | 'rate_limit';
export type AiFallbackReason = 'failure' | 'rate_limit';

export type AiRetrievalStrategy =
  | 'rag_runtime'
  | 'scope_filter'
  | 'freshness_filter'
  | 'hybrid_semantic'
  | 'hybrid_keyword';

export type AiRetrievalOutcome = 'hit' | 'miss' | 'error';
export type AiKnowledgeConsumer = 'rag' | 'live_guard';

const MODEL_LABEL_RE = /^[a-zA-Z0-9._:/+-]{1,96}$/;

/**
 * Modelnamen stammen ausschliesslich aus der serverseitigen Provider-Config.
 * Trotzdem wird das Label begrenzt, damit kaputte Konfiguration niemals
 * unkontrollierte Prometheus-Kardinalitaet erzeugt.
 */
export function safeAiModelLabel(model: string): string {
  const clean = String(model || '').trim();
  return MODEL_LABEL_RE.test(clean) ? clean : 'unknown';
}

export function recordAiProviderAttempt(input: {
  provider: ProviderName;
  model: string;
  outcome: AiProviderOutcome;
  latencyMs: number;
}): void {
  const labels = {
    provider: input.provider,
    model: safeAiModelLabel(input.model),
    outcome: input.outcome,
  };
  aiProviderAttemptsCounter.inc(labels);
  if (Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    aiProviderLatencyHistogram.observe(labels, input.latencyMs / 1000);
  }
}

/**
 * Wird nur fuer Call-Ergebnisse verwendet, bei denen callAI den aktuellen
 * Provider verlaesst und mit dem naechsten Kandidaten fortfaehrt (oder die
 * Kandidatenliste beendet). Kein erfundenes Ziel-Provider-Label.
 */
export function recordAiFallback(input: {
  fromProvider: ProviderName;
  reason: AiFallbackReason;
}): void {
  aiFallbackCounter.inc({
    from_provider: input.fromProvider,
    reason: input.reason,
  });
}

export interface AiRetrievalObservation {
  strategy: AiRetrievalStrategy;
  outcome: AiRetrievalOutcome;
  latencyMs: number;
  /** Optional because the high-level runtime caller only sees returned hits. */
  totalCandidates?: number;
  scopedCandidates?: number;
  freshCandidates?: number;
  selected?: number;
}

function observeCount(stage: 'all' | 'scoped' | 'fresh' | 'selected', value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  aiRetrievalCandidatesHistogram.observe({ stage }, Math.max(0, Math.floor(value)));
}

export function recordAiRetrieval(input: AiRetrievalObservation): void {
  const labels = { strategy: input.strategy, outcome: input.outcome };
  aiRetrievalCounter.inc(labels);
  if (Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    aiRetrievalDurationHistogram.observe(labels, input.latencyMs / 1000);
  }
  observeCount('all', input.totalCandidates);
  observeCount('scoped', input.scopedCandidates);
  observeCount('fresh', input.freshCandidates);
  observeCount('selected', input.selected);
}

export function recordAiKnowledgeSource(input: {
  sourceKind: KnowledgeSourceKind;
  trustLevel: KnowledgeTrustLevel;
  freshness: KnowledgeFreshness;
  sourceAgeDays: number;
  consumer: AiKnowledgeConsumer;
}): void {
  aiKnowledgeSourceCounter.inc({
    source_kind: input.sourceKind,
    trust_level: input.trustLevel,
    freshness: input.freshness,
    consumer: input.consumer,
  });
  if (Number.isFinite(input.sourceAgeDays) && input.sourceAgeDays >= 0) {
    aiKnowledgeSourceAgeHistogram.observe({
      source_kind: input.sourceKind,
      freshness: input.freshness,
      consumer: input.consumer,
    }, input.sourceAgeDays);
  }
}
