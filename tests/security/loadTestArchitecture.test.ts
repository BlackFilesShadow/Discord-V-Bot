import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/load-test-matrix.json'), 'utf8'));
const read = (relativePath: string): string => fs.readFileSync(path.resolve(relativePath), 'utf8');

describe('Stage 50 load test', () => {
  it('skips cleanly without BASE_URL', () => {
    expect(m.stage).toBe(50);
    const raw = execFileSync(process.execPath, ['scripts/load-test-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, LOAD_TEST_BASE_URL: '' },
    });
    const data = JSON.parse(raw);
    expect(data.stage).toBe(50);
    expect(data.skipped).toBe(true);
  });

  it('uses the production dashboard runtime with live PostgreSQL and complete measurements', () => {
    expect(m.schemaVersion).toBe(3);
    expect(m.stage).toBe(50);
    expect(['IMPLEMENTED_PENDING_DUAL_CI', 'VERIFIED']).toContain(m.status);
    const probe = read('scripts/full-stack-load-50.ts');
    expect(probe).toContain("process.env.STAGE50_REQUIRE_LIVE === '1'");
    expect(probe).toContain("require('../src/dashboard/server')");
    expect(probe).toContain("startDashboard(undefined, { port: 0, host: '127.0.0.1' })");
    expect(probe).toContain("return '/health/ready'");
    expect(probe).toContain("return '/api/v2/dev/status'");
    expect(probe).toContain('monitorEventLoopDelay');
    expect(probe).toContain('pg_stat_database');
    expect(probe).toContain('cpuUtilizationPercent');
    expect(probe).toContain('residual: []');
  });

  it.each(['.github/workflows/ci.yml', '.github/workflows/verification2.yml'])(
    'makes the SHA-bound Stage 50 artifact mandatory in %s',
    workflowPath => {
      const workflow = read(workflowPath);
      expect(workflow).toContain('npm run perf:load-50');
      expect(workflow).toContain("STAGE50_REQUIRE_LIVE: '1'");
      expect(workflow).toContain('STAGE50_EXACT_SHA: ${{ github.event.pull_request.head.sha || github.sha }}');
      expect(workflow).toContain('stage50-artifacts/${{ github.event.pull_request.head.sha || github.sha }}.json');
      expect(workflow).toContain('stage50-artifacts/*.json');
    },
  );

  it('pins dual exact-SHA evidence after promotion', () => {
    if (m.status !== 'VERIFIED') {
      expect(m.verification.artifacts).toEqual([]);
      expect(m.residual).toHaveLength(1);
      return;
    }
    expect(m.exactSha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.residual).toEqual([]);
    expect(m.cases.every((entry: { status: string }) => entry.status === 'dual-ci-verified')).toBe(true);
    expect(m.verification.artifacts).toHaveLength(2);
    for (const artifactPath of m.verification.artifacts as string[]) {
      const artifact = JSON.parse(read(artifactPath));
      expect(artifact.stage).toBe(50);
      expect(artifact.exactSha).toBe(m.exactSha);
      expect(artifact.passed).toBe(true);
      expect(artifact.residual).toEqual([]);
      expect(Object.values(artifact.gates).every(Boolean)).toBe(true);
    }
    const evidence = JSON.parse(read(m.verification.ciEvidence));
    expect(evidence.technicalSha).toBe(m.exactSha);
    expect(evidence.runs).toHaveLength(3);
    for (const run of evidence.runs as Array<{ attempt: number; headSha: string; conclusion: string }>) {
      expect(run.attempt).toBe(1);
      expect(run.headSha).toBe(m.exactSha);
      expect(run.conclusion).toBe('success');
    }
  });
});
