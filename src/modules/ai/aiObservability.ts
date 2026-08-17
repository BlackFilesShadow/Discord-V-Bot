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
import type { AiTaskProfile } from './providerCapabilities';
import type { ProviderName } from './providerStats';
import type {
  KnowledgeFreshness,
  KnowledgeSourceKind,
  KnowledgeTrustLevel,
} from './knowledgeProvenance';

export type AiProviderOutcome =
  | 'success'
  | 'failure'
  | 'rate_limit'
  | 'auth_or_model'
  | 'transient_retry'
  | 'unconfigured';

export type AiFallbackReason =
  | 'failure'
  | 'rate_limit'
  | 'auth_or_model'
  | 'unconfigured';

export type AiRetrievalStrategy =
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
  task: AiTaskProfile;
  outcome: AiProviderOutcome;
  latencyMs: number;
}): void {
  const labels = {
    provider: input.provider,
    model: safeAiModelLabel(input.model),
    task: input.task,
    outcome: input.outcome,
  };
  aiProviderAttemptsCounter.inc(labels);
  if (Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    aiProviderLatencyHistogram.observe(labels, input.latencyMs / 1000);
  }
}

export function recordAiFallback(input: {
  fromProvider: ProviderName;
  toProvider: ProviderName;
  reason: AiFallbackReason;
}): void {
  aiFallbackCounter.inc({
    from_provider: input.fromProvider,
    to_provider: input.toProvider,
    reason: input.reason,
  });
}

export interface AiRetrievalObservation {
  strategy: AiRetrievalStrategy;
  outcome: AiRetrievalOutcome;
  latencyMs: number;
  totalCandidates: number;
  scopedCandidates: number;
  freshCandidates: number;
  selected: number;
}

function nonNegativeCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

export function recordAiRetrieval(input: AiRetrievalObservation): void {
  const labels = { strategy: input.strategy, outcome: input.outcome };
  aiRetrievalCounter.inc(labels);
  if (Number.isFinite(input.latencyMs) && input.latencyMs >= 0) {
    aiRetrievalDurationHistogram.observe(labels, input.latencyMs / 1000);
  }
  aiRetrievalCandidatesHistogram.observe({ stage: 'all' }, nonNegativeCount(input.totalCandidates));
  aiRetrievalCandidatesHistogram.observe({ stage: 'scoped' }, nonNegativeCount(input.scopedCandidates));
  aiRetrievalCandidatesHistogram.observe({ stage: 'fresh' }, nonNegativeCount(input.freshCandidates));
  aiRetrievalCandidatesHistogram.observe({ stage: 'selected' }, nonNegativeCount(input.selected));
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
