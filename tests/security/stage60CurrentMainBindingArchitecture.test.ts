import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 60 current-main binding architecture', () => {
  it('pins the Stage-60 matrix to the Stage-59 merge SHA and preserves executable architecture surfaces', () => {
    const matrix = JSON.parse(read('docs/gesamtaudit-1-code-architecture-matrix.json')) as {
      stage: number;
      basedOnMainSha: string;
      status: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      residual: string[];
      outOfScopeNextStage?: string[];
    };

    expect(matrix.stage).toBe(60);
    expect(matrix.basedOnMainSha).toBe('0e4972924e06f837813555b41df636e7ad06453e');
    expect(matrix.status).toBe('VERIFIED');
    expect(matrix.contracts.currentMainBinding).toMatch(/exact current main SHA/i);
    expect(matrix.contracts.scopeBoundary).toMatch(/Stage 61|Dynamic-import/i);
    expect(matrix.cases.some((c) => c.id === 'current-main-exact-sha-binding' && c.status === 'runtime-verified')).toBe(true);
    expect(matrix.cases.some((c) => c.id === 'design-doc-rewrite-not-required-for-executable-proof')).toBe(true);
    expect(matrix.cases.some((c) => c.id === 'dynamic-import-completeness-owned-by-stage-61')).toBe(true);
    expect(matrix.residual).toEqual([]);
    expect((matrix.outOfScopeNextStage ?? []).join(' ')).toMatch(/Stage 61|dynamic-import/i);

    for (const p of [
      'tests/security/gesamtaudit1CodeArchitecture.test.ts',
      'tests/security/deadCodeLegacyCleanupArchitecture.test.ts',
      'scripts/gesamtaudit-scan.mjs',
      'src/dashboard/routes/v2.ts',
      'src/modules/ai/toolRuntime.ts',
    ]) {
      expect(fs.existsSync(path.join(root, p))).toBe(true);
    }

    expect(read('src/dashboard/routes/v2.ts')).toContain('v2Router.use(requireAuth)');
    expect(read('src/dashboard/routes/v2.ts')).toContain('v2Router.use(idempotency)');

    const stage57 = read('tests/security/deadCodeLegacyCleanupArchitecture.test.ts');
    expect(stage57).toMatch(/dynamic import|dynamic-coupling|runtime reachability/i);
    expect(stage57).toMatch(/filesystem command loading|workers|AI tools|Nitrado jobs/i);
  });
});
