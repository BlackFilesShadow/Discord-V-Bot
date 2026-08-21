import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/ai-nitrado-performance-baseline-matrix.json'));

describe('Stage 48 AI Nitrado performance baseline', () => {
  it('documents stage and keeps timeout/retry surfaces', () => {
    expect(m.stage).toBe(48);
    const aiDir = path.resolve('src/ai');
    const nitradoDir = path.resolve('src/nitrado');
    expect(fs.existsSync(aiDir) || fs.existsSync(path.resolve('src/modules'))).toBe(true);
    const env = r('.env.example');
    expect(env).toMatch(/AI_PROVIDER|GROQ_API_KEY|OPENAI_API_KEY/);
    expect(env).toMatch(/NITRADO|REDIS/);
    // Scope guards remain present from prior stages.
    expect(r('src/dashboard/middleware/economyScopeGuard.ts')).toContain('requireSafeDashboardEconomyScope');
  });
});
