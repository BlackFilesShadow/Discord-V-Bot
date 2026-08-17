import fs from 'fs';
import path from 'path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('AI-16 hallucination guard architecture', () => {
  test('context builder derives guard from the same scoped retrieval, never a parallel data path', () => {
    const source = read('src/modules/ai/contextBuilder.ts');
    expect(source).toContain('const snippets = await findRelevantKnowledge(guild.id, question, scope ? 12 : 3, scope?.id ?? null);');
    expect(source).toContain('buildResolvedDayzHallucinationGuard({');
    expect(source).toContain('snippets,');
    expect((source.match(/findRelevantKnowledge\(/g) ?? [])).toHaveLength(1);
    expect(source).toContain('buildUnresolvedDayzHallucinationGuard()');
  });

  test('trusted guard is passed by an opaque one-shot reference, not inside untrusted Discord data', () => {
    const context = read('src/modules/ai/contextBuilder.ts');
    const guard = read('src/modules/ai/dayzHallucinationGuard.ts');
    expect(context).toContain('attachHallucinationGuardReference(base, blocks.hallucinationGuard)');
    expect(context).toContain("wrapUntrustedContext(`AI_CONTEXT_BUNDLE_V2:");
    expect(guard).toContain("const GUARD_PREFIX = 'AI16_GUARD_REF:'");
    expect(guard).toContain('randomUUID()');
    expect(guard).toContain('pendingGuards.delete(id)');
    expect(guard).toContain('GUARD_TTL_MS');
  });

  test('only exact fresh verified LIVE_SERVER provenance for the selected connection becomes trusted facts', () => {
    const source = read('src/modules/ai/dayzHallucinationGuard.ts');
    expect(source).toContain("p.sourceKind !== 'LIVE_SERVER'");
    expect(source).toContain("p.trustLevel !== 'VERIFIED'");
    expect(source).toContain("p.freshness === 'EXPIRED'");
    expect(source).toContain('source.sourceRef.startsWith(exactPrefix)');
    expect(source).toContain('liveServerSourcePrefixForConnection(input.nitradoConnId)');
  });

  test('answer runtime consumes guard before direct knowledge paths and validates provider output before memory write', () => {
    const source = read('src/modules/ai/aiHandler.ts');
    const consumeAt = source.indexOf('consumeHallucinationGuardReference(opts.context)');
    const preflightAt = source.indexOf('preflightLiveServerQuestion(question, hallucinationGuard)');
    const catalogAt = source.indexOf('answerDayz129CatalogQuestion(question)');
    const validateAt = source.indexOf('validateLiveServerAnswer(question, safeResponse, hallucinationGuard)');
    const memoryAt = source.indexOf("const { recordTurn } = await import('./conversationMemory.js');", validateAt);
    expect(consumeAt).toBeGreaterThan(-1);
    expect(preflightAt).toBeGreaterThan(consumeAt);
    expect(catalogAt).toBeGreaterThan(preflightAt);
    expect(validateAt).toBeGreaterThan(catalogAt);
    expect(memoryAt).toBeGreaterThan(validateAt);
    expect(source).toContain('formatHallucinationGuardPrompt(hallucinationGuard)');
    expect(source).toContain('buildHallucinationGuardFallback(guardValidation.violations)');
  });

  test('guard core is DB/provider free and conflicts fail closed', () => {
    const source = read('src/modules/ai/dayzHallucinationGuard.ts');
    expect(source).not.toMatch(/database\/prisma|callAI|axios|providerStats|OpenAI|Gemini|Groq|Cerebras|OpenRouter/);
    expect(source).toContain('conflict: row.values.size > 1');
    expect(source).toContain('CONFLICTING_VERIFIED_SOURCES');
    expect(source).toContain('REQUESTED_LIVE_FACT_NOT_VERIFIED');
    expect(source).toContain('UNSUPPORTED_VALUE:');
    expect(source).toContain('UNSUPPORTED_IDENTIFIER:');
  });

  test('/ai ask receives the same guild-scoped context/guard path as mention chat', () => {
    const source = read('src/commands/user/ai.ts');
    expect(source).toContain("import { buildServerUserContext } from '../../modules/ai/contextBuilder';");
    expect(source).toContain('await buildServerUserContext({');
    expect(source).toContain('guildId: interaction.guildId');
  });
});
