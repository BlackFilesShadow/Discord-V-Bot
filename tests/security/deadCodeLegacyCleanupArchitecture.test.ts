import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/dead-code-legacy-cleanup-matrix.json')) as {
  stage: number;
  basedOnMainSha: string;
  status: string;
  decision: string;
  residual: string[];
  cases: Array<{ id: string }>;
  contracts: Record<string, string>;
};
const pkg = JSON.parse(r('package.json')) as { dependencies?: Record<string, string> };

describe('Stage 57 dead code legacy cleanup', () => {
  it('records conservative cleanup policy on the current main baseline', () => {
    expect(m.stage).toBe(57);
    expect(m.basedOnMainSha).toBe('425cf4d7b70a9e417d1c6a6a9622e6330f9ceea9');
    expect(m.status).toBe('PARTIAL');
    expect(m.residual.join(' ')).toMatch(/dynamic coupling/i);
    expect(m.decision).toMatch(/No mass deletion/);
    expect(m.contracts.proofRequired).toMatch(/dynamic imports|workers|AI/i);
    expect(m.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['passport-stack-already-removed', 'ai-tool-registry-intact']),
    );
    expect(r('tests/security/deadCodeLegacyCleanupArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('keeps proven-used runtime surfaces and does not reintroduce passport', () => {
    expect(pkg.dependencies?.passport).toBeUndefined();
    expect(pkg.dependencies?.['passport-discord']).toBeUndefined();
    expect(fs.existsSync(path.resolve('src/modules/ai/toolRuntime.ts'))).toBe(true);
    expect(fs.existsSync(path.resolve('src/modules/nitrado/jobWorker.ts'))).toBe(true);
    expect(r('src/modules/ai/toolRuntime.ts')).toMatch(/executeTool|ToolRuntime|registry/i);
    expect(r('src/modules/nitrado/jobWorker.ts').length).toBeGreaterThan(100);
  });
});
