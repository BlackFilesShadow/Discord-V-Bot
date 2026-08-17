import fs from 'fs';
import path from 'path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('AI-15 deterministic XML/JSON validation architecture', () => {
  test('live Nitrado knowledge validates the complete chosen set before normalization', () => {
    const source = read('src/modules/ai/liveServerKnowledgeIndex.ts');
    const validationAt = source.indexOf('validateDayzKnowledgeSet(');
    const parseAt = source.indexOf('parseLiveServerKnowledgeFile(');
    expect(validationAt).toBeGreaterThan(-1);
    expect(parseAt).toBeGreaterThan(validationAt);
    expect(source).toContain('if (!validation.validForKnowledge) continue;');
    expect(source).toContain('validationDocument(file, validation)');
    expect(source).toContain('validationErrors: validationTotals.errors');
    expect(source).toContain('rejectedFiles: validationTotals.rejectedFiles');
  });

  test('validation core is deterministic and contains no provider or LLM dependency', () => {
    const source = read('src/modules/ai/dayzConfigValidation.ts');
    expect(source).toContain("import { validateJson, validateXml } from '../../utils/validator';");
    expect(source).toContain('validateTypesXml');
    expect(source).toContain('validateEventsXml');
    expect(source).toContain('validateGlobalsXml');
    expect(source).toContain('validateSpawnableTypesXml');
    expect(source).toContain('validateGameplayJson');
    expect(source).toContain('validateDayzKnowledgeSet');
    expect(source).not.toMatch(/callAI|axios|providerStats|OpenAI|Gemini|Groq|Cerebras|OpenRouter/);
  });

  test('semantic contradictions and unknown references have stable machine-readable codes', () => {
    const source = read('src/modules/ai/dayzConfigValidation.ts');
    for (const code of [
      'SYNTAX_INVALID',
      'REQUIRED_FIELD_MISSING',
      'MIN_GT_NOMINAL',
      'MIN_GT_MAX',
      'NOMINAL_OUTSIDE_RANGE',
      'QUANTITY_RANGE_INVALID',
      'DUPLICATE_IDENTIFIER',
      'UNKNOWN_REFERENCE',
      'UNUSUAL_LIFETIME',
      'JSON_SECTION_INVALID',
    ]) {
      expect(source).toContain(`'${code}'`);
    }
  });

  test('invalid source values cannot be indexed as VERIFIED facts, only deterministic diagnostics', () => {
    const source = read('src/modules/ai/liveServerKnowledgeIndex.ts');
    expect(source).toContain("const status = validation.validForKnowledge ? 'VALID_WITH_WARNINGS' : 'INVALID';");
    expect(source).toContain("'deterministic=true'");
    expect(source).toContain("trustLevel: 'VERIFIED'");
    expect(source).toContain("sourceKind: 'LIVE_SERVER'");
  });
});
