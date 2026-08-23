import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const r = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 59 chaos revalidation', () => {
  it('binds the chaos matrix to the current main without overstating live process-kill coverage', () => {
    const m = JSON.parse(r('docs/chaos-test-matrix.json')) as {
      stage: number;
      status: string;
      basedOnMainSha: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      residual: string[];
    };

    expect(m.stage).toBe(59);
    expect(m.status).toBe('PARTIAL');
    expect(m.basedOnMainSha).toBe('07aad8945afcc2a1589c2997862d12053b2a3a37');
    expect(m.contracts.runtimeHarness).toMatch(/chaos-smoke|Jest/i);
    expect(m.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nitrado-circuit-open-blocks', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'ssrf-private-blocked', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'path-traversal-blocked', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'kill-postgres-container', status: 'residual-needs-docker' }),
    ]));
    expect(m.residual.join(' ')).toMatch(/Docker Compose|staging|process-kill/i);
  });

  it('keeps the executable chaos harness and core defensive modules present', () => {
    const required = [
      'scripts/chaos-smoke.mjs',
      'src/modules/nitrado/circuitBreaker.ts',
      'src/utils/ssrf.ts',
      'src/utils/pathSafety.ts',
      'tests/security/waveFPerfChaosJourneyRuntime.test.ts',
    ];
    for (const p of required) expect(fs.existsSync(path.join(root, p))).toBe(true);
    expect(r('tests/security/stage59ChaosRevalidationArchitecture.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });
});
