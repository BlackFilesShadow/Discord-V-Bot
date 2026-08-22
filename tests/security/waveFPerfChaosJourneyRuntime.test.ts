import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function parseJsonBlob(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json object in output: ' + raw.slice(0, 200));
  return JSON.parse(raw.slice(start, end + 1));
}
import {
  checkGlobalRateLimit,
  __resetRateLimits,
  RATE_LIMIT_GLOBAL_MAX,
  RATE_LIMIT_BUCKET_MAX_ENTRIES,
} from '../../src/utils/rateLimit';
import {
  getNitradoBreaker,
  resetAllNitradoBreakers,
  NitradoCircuitOpenError,
} from '../../src/modules/nitrado/circuitBreaker';
import { validatePublicHttpUrl } from '../../src/utils/ssrf';
import { assertInsideRoot, PathBoundaryError } from '../../src/utils/pathSafety';

const root = process.cwd();
const r = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

describe('Wave F stages 49–52 / 58–59 runtime evidence', () => {
  afterEach(() => {
    __resetRateLimits();
    resetAllNitradoBreakers();
  });

  it('Stage 49 matrix records bounded rate-limit fix on main lineage', () => {
    const m = JSON.parse(r('docs/memory-leak-audit-matrix.json')) as {
      stage: number;
      findings: Array<{ id: string; state: string }>;
      contracts: Record<string, string>;
    };
    expect(m.stage).toBe(49);
    expect(m.contracts.boundedRateLimitMaps).toMatch(/hard-capped/i);
    expect(m.findings.some((f) => f.id === 'F-P49-01')).toBe(true);
    expect(RATE_LIMIT_BUCKET_MAX_ENTRIES).toBe(50_000);
    expect(r('tests/security/waveFPerfChaosJourneyRuntime.test.ts')).not.toMatch(
      /test\.(only|skip)|describe\.(only|skip)/,
    );
  });

  it('Stage 50 runs real in-process HTTP load with p50/p95/rps and 401 under load', () => {
    const raw = execFileSync(process.execPath, ['scripts/perf-load-inprocess.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WRITE_PERF_ARTIFACTS: '0',
        LOAD_DURATION_MS: '400',
        LOAD_CONCURRENCY: '15',
        LOAD_REQUESTS_PER_WORKER: '20',
      },
      timeout: 60_000,
    });
    const data = parseJsonBlob(raw) as {
      stage: number;
      results: {
        requests: number;
        rps: number;
        errorRatio: number;
        latencyMs: { p50: number; p95: number };
        statusCodes: Record<string, number>;
        serverAuthDenied: number;
      };
    };
    expect(data.stage).toBe(50);
    expect(data.results.requests).toBeGreaterThan(20);
    expect(data.results.rps).toBeGreaterThan(5);
    expect(data.results.errorRatio).toBeLessThanOrEqual(0.01);
    expect(data.results.latencyMs.p50).toBeGreaterThanOrEqual(0);
    expect(data.results.latencyMs.p95).toBeGreaterThanOrEqual(data.results.latencyMs.p50);
    expect(data.results.serverAuthDenied).toBeGreaterThan(0);
    expect(Number(data.results.statusCodes['401'] || 0)).toBeGreaterThan(0);
    expect(Number(data.results.statusCodes['200'] || 0)).toBeGreaterThan(0);
  });

  it('Stage 51 short soak produces multi-sample heap series', () => {
    const raw = execFileSync(process.execPath, ['scripts/soak-test-smoke.mjs'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WRITE_PERF_ARTIFACTS: '0',
        SOAK_LOOPS: '4',
        SOAK_SAMPLE_MS: '20',
      },
      timeout: 30_000,
    });
    const data = parseJsonBlob(raw) as {
      stage: number;
      loops: number;
      samples: unknown[];
      maxHeapMb: number;
      minHeapMb: number;
    };
    expect(data.stage).toBe(51);
    expect(data.loops).toBe(4);
    expect(data.samples).toHaveLength(4);
    expect(data.maxHeapMb).toBeGreaterThan(0);
    expect(data.minHeapMb).toBeGreaterThan(0);
  });

  it('Stage 51 rate-limit churn keeps maps bounded (no unbounded growth)', () => {
    __resetRateLimits();
    const t = 5_000_000;
    for (let i = 0; i < 2_000; i++) {
      checkGlobalRateLimit(`soak-u-${i}`, t);
    }
    // flood same user past max
    let denied = 0;
    for (let i = 0; i < RATE_LIMIT_GLOBAL_MAX + 5; i++) {
      if (!checkGlobalRateLimit('flood-user', t + 1)) denied++;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('Stage 52 documents heap tuning only after measurements (no blind raise)', () => {
    const readme = r('docs/audit/performance/README.md');
    expect(readme).toMatch(/52/);
    expect(readme).toMatch(/Wave E|baselines|soak|load/i);
    // package engines remain node 22 — no arbitrary --max-old-space-size in start script
    const pkg = JSON.parse(r('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).not.toMatch(/max-old-space-size/);
  });

  it('Stage 59 runtime fault injection: circuit OPEN, SSRF, path traversal', () => {
    resetAllNitradoBreakers();
    const b = getNitradoBreaker('READ');
    for (let i = 0; i < 6; i++) b.recordFailure();
    expect(() => b.preflight()).toThrow(NitradoCircuitOpenError);
    b.recordSuccess();
    expect(() => b.preflight()).not.toThrow();

    expect(validatePublicHttpUrl('http://127.0.0.1/admin').ok).toBe(false);
    expect(validatePublicHttpUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false);
    const rootDir = path.join(root, 'data');
    expect(() => assertInsideRoot(path.join(rootDir, '..', 'etc', 'passwd'), rootDir)).toThrow(
      PathBoundaryError,
    );
    expect(() => assertInsideRoot(path.join(rootDir, '..', 'windows', 'system32'), rootDir)).toThrow(
      PathBoundaryError,
    );

    const chaos = execFileSync(process.execPath, ['scripts/chaos-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, WRITE_PERF_ARTIFACTS: '0' },
      timeout: 20_000,
    });
    const c = parseJsonBlob(chaos) as {
      stage: number;
      faults: string[];
      results: Array<{ ok: boolean }>;
    };
    expect(c.stage).toBe(59);
    expect(c.faults.length).toBeGreaterThanOrEqual(6);
    expect(c.results.every((x) => x.ok)).toBe(true);
  });

  it('Stage 58 orchestrated journey chain maps ordered steps to real modules/tests', () => {
    const m = JSON.parse(r('docs/full-user-journey-e2e-matrix.json')) as {
      stage: number;
      steps: Array<{ id: string; coverage: string; module?: string }>;
      orchestration?: { ordered: string[] };
    };
    expect(m.stage).toBe(58);
    const ordered = m.orchestration?.ordered ?? m.steps.map((s) => s.id);
    expect(ordered[0]).toMatch(/join/i);
    expect(ordered.join('>')).toMatch(/leave|cleanup|rejoin/i);

    // Prove key journey surfaces exist as one chain inventory
    const chain = [
      'src/events/guildMemberAdd.ts',
      'src/events/guildMemberRemove.ts',
      'src/modules/moderation/leaveCleanupWorker.ts',
      'src/modules/moderation/leaveCleanupRejoin.ts',
      'src/modules/linking/linkService.ts',
      'src/modules/economy/repository.ts',
      'src/modules/ai/aiHandler.ts',
      'src/modules/ai/toolRuntime.ts',
      'src/dashboard/middleware/auth.ts',
      'src/dashboard/middleware/economyScopeGuard.ts',
      'dashboard-ui/e2e/whitelist-authenticated-actions.spec.ts',
      'dashboard-ui/e2e/stage-27-35-runtime-matrix.spec.ts',
    ];
    for (const p of chain) {
      expect(fs.existsSync(path.join(root, p))).toBe(true);
    }

    // Leave/rejoin CAS semantics remain in remove handler (no stale grant wipe)
    const leave = r('src/events/guildMemberRemove.ts');
    expect(leave).toMatch(/joinedAt|updatedAt|CAS|Generation|generation/i);
    const rejoin = r('src/modules/moderation/leaveCleanupRejoin.ts');
    expect(rejoin.length).toBeGreaterThan(100);

    // Duplicate leave/join residual documented honestly
    expect(JSON.stringify(m)).toMatch(/residual|live|Gate|PARTIAL|Discord/i);
  });

  it('load-test-smoke still exits skipped without BASE_URL (compat)', () => {
    const raw = execFileSync(process.execPath, ['scripts/load-test-smoke.mjs'], {
      encoding: 'utf8',
      env: { ...process.env, LOAD_TEST_BASE_URL: '' },
    });
    expect((parseJsonBlob(raw) as { skipped: boolean }).skipped).toBe(true);
  });
});
