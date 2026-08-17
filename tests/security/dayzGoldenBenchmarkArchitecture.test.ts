import fs from 'node:fs';
import path from 'node:path';

describe('AI-19 Golden DayZ benchmark architecture', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const corpusPath = path.join(repoRoot, 'src/modules/ai/dayzGoldenBenchmark.ts');
  const evaluatorPath = path.join(repoRoot, 'src/modules/ai/dayzEvaluation.ts');
  const gatePath = path.join(repoRoot, 'tests/ai/dayzGoldenEvaluation.test.ts');

  test('release evaluator remains provider/network independent', () => {
    const source = fs.readFileSync(evaluatorPath, 'utf8');
    for (const forbidden of [
      /axios/,
      /fetch\s*\(/,
      /openai/i,
      /groq/i,
      /gemini/i,
      /cerebras/i,
      /openrouter/i,
      /callAI/,
      /providerRegistry/,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
    expect(source).toContain('looksLikeLiveServerKnowledgeQuestion');
    expect(source).toContain('validateDayzKnowledgeSet');
    expect(source).toContain('preflightLiveServerQuestion');
    expect(source).toContain('validateLiveServerAnswer');
  });

  test('corpus covers the four mandatory safety domains and the CI gate requires 100 percent', () => {
    const corpus = fs.readFileSync(corpusPath, 'utf8');
    const gate = fs.readFileSync(gatePath, 'utf8');
    for (const category of ['BOUNDARY', 'VALIDATION', 'LIVE_PREFLIGHT', 'ANSWER_VALIDATION']) {
      expect(corpus).toContain(`category: '${category}'`);
    }
    expect(gate).toContain('expect(report.failed).toBe(0)');
    expect(gate).toContain('expect(report.score).toBe(1)');
  });
});
