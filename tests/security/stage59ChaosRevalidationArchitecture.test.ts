import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const r = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Stage 59 chaos revalidation', () => {
  it('binds the chaos matrix to current main and requires the Docker process-kill residual closed', () => {
    const m = JSON.parse(r('docs/chaos-test-matrix.json')) as {
      stage: number;
      status: string;
      basedOnMainSha: string;
      contracts: Record<string, string>;
      cases: Array<{ id: string; status: string }>;
      evidence?: string[];
      residual: string[];
    };

    expect(m.stage).toBe(59);
    expect(m.status).toBe('VERIFIED');
    expect(m.basedOnMainSha).toBe('7ca09272eb583dbaa3bbcc7433032ce7f11098de');
    expect(m.contracts.runtimeHarness).toMatch(/chaos-smoke|Jest/i);
    expect(m.contracts.dockerProcessKillHarness).toMatch(/stage59-process-kill-chaos|stage59-chaos\.yml|PostgreSQL|Redis/i);
    expect(m.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nitrado-circuit-open-blocks', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'ssrf-private-blocked', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'path-traversal-blocked', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'kill-postgres-container', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'postgres-same-client-recovery', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'kill-redis-container', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'redis-client-recovery', status: 'runtime-verified' }),
      expect.objectContaining({ id: 'dual-isolated-chaos-runs', status: 'runtime-verified' }),
    ]));
    expect(m.evidence).toEqual(expect.arrayContaining([
      'scripts/stage59-process-kill-chaos.ts',
      '.github/workflows/stage59-chaos.yml',
    ]));
    expect(m.residual).toEqual([]);
  });

  it('keeps the executable chaos harnesses and core defensive modules present', () => {
    const required = [
      'scripts/chaos-smoke.mjs',
      'scripts/stage59-process-kill-chaos.ts',
      '.github/workflows/stage59-chaos.yml',
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

  it('pins two isolated real-service chaos jobs and exact-SHA artifacts in CI', () => {
    const workflow = r('.github/workflows/stage59-chaos.yml');
    expect(workflow).toMatch(/stage59-primary:[\s\S]*postgres:16[\s\S]*redis:7\.4-alpine/);
    expect(workflow).toMatch(/stage59-verification-2:[\s\S]*postgres:16[\s\S]*redis:7\.4-alpine/);
    expect(workflow.match(/STAGE59_REQUIRE_DOCKER:\s*'1'/g)?.length).toBe(2);
    expect(workflow.match(/npx ts-node scripts\/stage59-process-kill-chaos\.ts/g)?.length).toBe(2);
    expect(workflow).toContain('github.event.pull_request.head.sha || github.sha');
    expect(workflow).toMatch(/stage59-process-kill-primary/);
    expect(workflow).toMatch(/stage59-process-kill-verification2/);
  });
});
