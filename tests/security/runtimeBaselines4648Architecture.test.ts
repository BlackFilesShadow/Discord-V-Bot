import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const root = process.cwd();

const m46 = JSON.parse(r('docs/runtime-baseline-46-matrix.json')) as {
  stage: number;
  contracts: Record<string, string>;
  cases: Array<{ id: string; status: string }>;
};
const m47 = JSON.parse(r('docs/data-plane-baseline-47-matrix.json')) as {
  stage: number;
  cases: Array<{ id: string; status: string }>;
};
const m48 = JSON.parse(r('docs/ai-nitrado-performance-baseline-matrix.json')) as {
  stage: number;
  contracts: Record<string, string>;
  cases: Array<{ id: string; status: string }>;
  verification: { probeScript: string };
};

describe('Wave E Stages 46–48 runtime baselines', () => {
  it('documents stage matrices without skip/only', () => {
    expect(m46.stage).toBe(46);
    expect(m47.stage).toBe(47);
    expect(m48.stage).toBe(48);
    expect(m46.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['event-loop-delay-sampled', 'memory-rss-heap-sampled']),
    );
    expect(m47.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['prisma-pool-max-10', 'query-latency-hook']),
    );
    expect(m48.cases.map((c) => c.id)).toEqual(
      expect.arrayContaining(['nitrado-circuit-breaker', 'ai-timeout-30s']),
    );
    const self = r('tests/security/runtimeBaselines4648Architecture.test.ts');
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });

  it('Stage 46: metrics wiring + real event-loop/memory sample in-process', async () => {
    const metrics = r('src/utils/metrics.ts');
    expect(metrics).toMatch(/collectDefaultMetrics\(\{\s*register:\s*metricsRegistry,\s*prefix:\s*'vbot_'/);
    expect(metrics).toMatch(/aiProviderLatencyHistogram/);
    expect(metrics).toMatch(/dbQueryHistogram/);

    const cpu0 = process.cpuUsage();
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    const busyUntil = Date.now() + 50;
    while (Date.now() < busyUntil) {
      Math.sqrt(Date.now());
    }
    await new Promise((r) => setTimeout(r, 80));
    h.disable();
    const cpu = process.cpuUsage(cpu0);
    const mem = process.memoryUsage();
    expect(mem.rss).toBeGreaterThan(1_000_000);
    expect(mem.heapUsed).toBeGreaterThan(100_000);
    expect(cpu.user + cpu.system).toBeGreaterThan(0);
    // ELD API must be usable (values may be 0 on very idle short windows on Windows)
    expect(typeof h.percentile).toBe('function');
    expect(Number(h.percentile(50))).toBeGreaterThanOrEqual(0);
    expect(Number(h.max)).toBeGreaterThanOrEqual(0);

    expect(fs.existsSync(path.join(root, 'scripts/runtime-baselines-46-48.mjs'))).toBe(true);
  });

  it('Stage 47: prisma pool/tx bounds, redis surface, nitrado worker', () => {
    const prisma = r('src/database/prisma.ts');
    expect(prisma).toMatch(/max:\s*10/);
    expect(prisma).toMatch(/connection_limit/);
    expect(prisma).toMatch(/maxWait:\s*5_000/);
    expect(prisma).toMatch(/timeout:\s*15_000/);
    expect(prisma).toMatch(/recordPrismaLatency/);
    const pkg = JSON.parse(r('package.json')) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies?.redis || pkg.dependencies?.ioredis).toBeTruthy();
    expect(r('.env.example')).toMatch(/REDIS_URL/);
    expect(r('prisma/schema.prisma')).toMatch(/model NitradoJob/);
    expect(fs.existsSync(path.join(root, 'src/modules/nitrado/jobWorker.ts'))).toBe(true);
  });

  it('Stage 48: AI/Nitrado timeout retry circuit metrics + scope guard', () => {
    const nitrado = r('src/modules/nitrado/nitradoClient.ts');
    expect(nitrado).toMatch(/timeout:\s*15_000/);
    expect(nitrado).toMatch(/attempt <= 3/);
    expect(nitrado).toMatch(/parseRetryAfterMs/);
    const circuit = r('src/modules/nitrado/circuitBreaker.ts');
    expect(circuit).toMatch(/HALF_OPEN/);
    expect(circuit).toMatch(/NitradoCircuitBreaker/);
    const ai = r('src/modules/ai/aiHandler.ts');
    expect(ai).toMatch(/timeout:\s*30000/);
    expect(ai).toMatch(/is429/);
    expect(ai).toMatch(/transient && attempt === 1/);
    const metrics = r('src/utils/metrics.ts');
    expect(metrics).toMatch(/aiFallbackCounter/);
    expect(metrics).toMatch(/aiProviderLatencyHistogram/);
    expect(r('src/dashboard/middleware/economyScopeGuard.ts')).toContain(
      'requireSafeDashboardEconomyScope',
    );
  });

  it('probe script exits 0 and emits stages 46-48 JSON (no artifact write)', () => {
    const out = execSync('node scripts/runtime-baselines-46-48.mjs', {
      encoding: 'utf8',
      env: { ...process.env, WRITE_PERF_ARTIFACTS: '0', RUNTIME_BASELINE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    const jsonStart = out.indexOf('{');
    const parsed = JSON.parse(out.slice(jsonStart)) as {
      stages: { 46: { stage: number; process: { rssMb: number } }; 47: { contractsOk: boolean }; 48: { contractsOk: boolean } };
    };
    expect(parsed.stages[46].stage).toBe(46);
    expect(parsed.stages[46].process.rssMb).toBeGreaterThan(1);
    expect(parsed.stages[47].contractsOk).toBe(true);
    expect(parsed.stages[48].contractsOk).toBe(true);
  });

  it('parseRetryAfterMs and circuit status surfaces remain callable', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { parseRetryAfterMs } = require('../../src/modules/nitrado/nitradoClient') as {
      parseRetryAfterMs: (h: unknown, cap?: number) => number;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getNitradoBreakerStatus } = require('../../src/modules/nitrado/circuitBreaker') as {
      getNitradoBreakerStatus: () => Record<string, { state: string }>;
    };
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(null)).toBe(2000);
    const st = getNitradoBreakerStatus();
    expect(st.READ.state).toMatch(/CLOSED|OPEN|HALF_OPEN/);
    expect(st.WRITE.state).toMatch(/CLOSED|OPEN|HALF_OPEN/);
  });
});
