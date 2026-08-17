import fs from 'node:fs';
import path from 'node:path';

describe('AI-20 observability architecture', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const metricsPath = path.join(repoRoot, 'src/utils/metrics.ts');
  const observabilityPath = path.join(repoRoot, 'src/modules/ai/aiObservability.ts');
  const providerStatsPath = path.join(repoRoot, 'src/modules/ai/providerStats.ts');
  const contextBuilderPath = path.join(repoRoot, 'src/modules/ai/contextBuilder.ts');

  test('AI metric labels remain bounded and contain no request/user/source identifiers', () => {
    const source = fs.readFileSync(metricsPath, 'utf8');
    const aiSection = source.slice(source.indexOf('AI-20:'));
    for (const forbidden of [
      'guildId', 'guild_id', 'userId', 'user_id', 'discordId', 'discord_id',
      'question', 'prompt', 'response', 'sourceRef', 'source_ref', 'channelId', 'channel_id',
    ]) {
      expect(aiSection).not.toMatch(new RegExp(`labelNames:[^\\n]*${forbidden}`, 'i'));
    }
    expect(aiSection).toContain("labelNames: ['provider', 'model', 'outcome']");
    expect(aiSection).toContain("labelNames: ['from_provider', 'reason']");
    expect(aiSection).toContain("labelNames: ['source_kind', 'trust_level', 'freshness', 'consumer']");
  });

  test('canonical provider outcome path records provider/model/latency and fallback decisions', () => {
    const source = fs.readFileSync(providerStatsPath, 'utf8');
    expect(source).toContain("from './aiObservability'");
    expect(source).toContain('recordAiProviderAttempt({');
    expect(source).toContain('model: getConfiguredModel(provider)');
    expect(source).toContain('latencyMs,');
    expect(source).toContain('recordAiFallback({');
    expect(source).not.toMatch(/recordAiProviderAttempt\([\s\S]{0,300}(guild|user|discord|question|prompt|response|sourceRef)/i);
  });

  test('runtime RAG records retrieval plus used source trust/freshness without sourceRef labels', () => {
    const source = fs.readFileSync(contextBuilderPath, 'utf8');
    expect(source).toContain("strategy: 'rag_runtime'");
    expect(source).toContain('recordAiRetrieval({');
    expect(source).toContain('recordAiKnowledgeSource({');
    expect(source).toContain('sourceKind: snippet.provenance.sourceKind');
    expect(source).toContain('trustLevel: snippet.provenance.trustLevel');
    expect(source).toContain('freshness: snippet.provenance.freshness');
    expect(source).toContain('sourceAgeDays: snippet.provenance.sourceAgeDays');
    expect(source).not.toMatch(/recordAiKnowledgeSource\([\s\S]{0,400}sourceRef/);
  });

  test('observability helper accepts only controlled enums and sanitizes model labels', () => {
    const source = fs.readFileSync(observabilityPath, 'utf8');
    expect(source).toContain('safeAiModelLabel');
    expect(source).toContain("export type AiProviderOutcome = 'success' | 'failure' | 'rate_limit';");
    expect(source).toContain("export type AiKnowledgeConsumer = 'rag' | 'live_guard';");
    expect(source).not.toMatch(/guildId\s*:/);
    expect(source).not.toMatch(/userId\s*:/);
    expect(source).not.toMatch(/question\s*:/);
    expect(source).not.toMatch(/sourceRef\s*:/);
  });
});
