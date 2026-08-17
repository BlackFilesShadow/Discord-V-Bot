import { metricsRegistry } from '../../src/utils/metrics';
import {
  recordAiFallback,
  recordAiKnowledgeSource,
  recordAiProviderAttempt,
  recordAiRetrieval,
  safeAiModelLabel,
} from '../../src/modules/ai/aiObservability';

describe('AI-20 observability', () => {
  test('model labels are bounded and malformed/high-cardinality values collapse to unknown', () => {
    expect(safeAiModelLabel('llama-3.3-70b-versatile')).toBe('llama-3.3-70b-versatile');
    expect(safeAiModelLabel('openai/gpt-5.1')).toBe('openai/gpt-5.1');
    expect(safeAiModelLabel('model with spaces')).toBe('unknown');
    expect(safeAiModelLabel('x'.repeat(97))).toBe('unknown');
    expect(safeAiModelLabel('')).toBe('unknown');
  });

  test('provider/model/latency and fallback metrics expose only bounded operational labels', async () => {
    recordAiProviderAttempt({
      provider: 'groq',
      model: 'observability-test-model',
      outcome: 'success',
      latencyMs: 125,
    });
    recordAiFallback({ fromProvider: 'cerebras', reason: 'rate_limit' });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('vbot_ai_provider_attempts_total');
    expect(metrics).toContain('provider="groq"');
    expect(metrics).toContain('model="observability-test-model"');
    expect(metrics).toContain('outcome="success"');
    expect(metrics).toContain('vbot_ai_provider_latency_seconds');
    expect(metrics).toContain('vbot_ai_provider_fallback_total');
    expect(metrics).toContain('from_provider="cerebras"');
    expect(metrics).toContain('reason="rate_limit"');
  });

  test('retrieval and source/freshness observations expose no sourceRef or request identity', async () => {
    recordAiRetrieval({
      strategy: 'rag_runtime',
      outcome: 'hit',
      latencyMs: 18,
      selected: 3,
    });
    recordAiKnowledgeSource({
      sourceKind: 'LIVE_SERVER',
      trustLevel: 'VERIFIED',
      freshness: 'FRESH',
      sourceAgeDays: 0.25,
      consumer: 'live_guard',
    });

    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('vbot_ai_retrieval_total');
    expect(metrics).toContain('strategy="rag_runtime"');
    expect(metrics).toContain('outcome="hit"');
    expect(metrics).toContain('vbot_ai_retrieval_candidates');
    expect(metrics).toContain('stage="selected"');
    expect(metrics).toContain('vbot_ai_knowledge_sources_total');
    expect(metrics).toContain('source_kind="LIVE_SERVER"');
    expect(metrics).toContain('trust_level="VERIFIED"');
    expect(metrics).toContain('freshness="FRESH"');
    expect(metrics).toContain('consumer="live_guard"');
    expect(metrics).toContain('vbot_ai_knowledge_source_age_days');
  });

  test('unknown candidate counts are omitted instead of invented as zero', async () => {
    const before = await metricsRegistry.getSingleMetricAsString('vbot_ai_retrieval_candidates');
    recordAiRetrieval({ strategy: 'rag_runtime', outcome: 'miss', latencyMs: 2 });
    const after = await metricsRegistry.getSingleMetricAsString('vbot_ai_retrieval_candidates');
    expect(after).toBe(before);
  });
});
