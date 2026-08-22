/**
 * Wave E — Stages 46–48 runtime baseline probe.
 * Captures SHA-bound JSON under docs/audit/performance/<sha>/.
 *
 * Honest scope:
 * - 46: real in-process Node samples (memory, CPU, event-loop, handles)
 * - 47: structural data-plane contracts + optional live DB/Redis when env set
 * - 48: structural AI/Nitrado timeout/retry/circuit contracts + synthetic latency sample
 *
 * Usage: node scripts/runtime-baselines-46-48.mjs
 * Env:
 *   RUNTIME_BASELINE_MS (default 1500)
 *   DATABASE_URL (optional live SELECT 1)
 *   REDIS_URL (optional PING)
 *   WRITE_PERF_ARTIFACTS=0 to skip disk write
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function gitSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA || 'unknown';
  }
}

function activeResourceCounts() {
  const counts = { handlesApprox: 0, requests: 0 };
  try {
    // Node 18+: process.getActiveResourcesInfo()
    if (typeof process.getActiveResourcesInfo === 'function') {
      const info = process.getActiveResourcesInfo();
      counts.handlesApprox = info.length;
      const byType = {};
      for (const t of info) byType[t] = (byType[t] || 0) + 1;
      counts.byType = byType;
    }
  } catch {
    /* ignore */
  }
  try {
    counts.requests = process._getActiveRequests?.()?.length ?? 0;
    counts.handlesLegacy = process._getActiveHandles?.()?.length ?? 0;
  } catch {
    /* ignore */
  }
  return counts;
}

async function sampleStage46(sampleMs) {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  // mild synthetic load so ELD is non-zero but controlled
  let n = 0;
  const endAt = Date.now() + sampleMs;
  while (Date.now() < endAt) {
    n += Math.sqrt(n + 1);
    if (n % 10_000 < 1) await new Promise((r) => setImmediate(r));
  }
  const cpu = process.cpuUsage(cpu0);
  const mem = process.memoryUsage();
  h.disable();
  const toMs = (ns) => Number(ns) / 1e6;
  const resources = activeResourceCounts();
  return {
    stage: 46,
    kind: 'runtime-process-baseline',
    sampleMs: Math.round(performance.now() - t0),
    node: process.version,
    platform: process.platform,
    cpuCount: cpus().length,
    loadAvg: loadavg(),
    osMem: {
      totalMb: +(totalmem() / 1024 / 1024).toFixed(2),
      freeMb: +(freemem() / 1024 / 1024).toFixed(2),
    },
    process: {
      rssMb: +(mem.rss / 1024 / 1024).toFixed(2),
      heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      externalMb: +(mem.external / 1024 / 1024).toFixed(2),
      arrayBuffersMb: +((mem.arrayBuffers || 0) / 1024 / 1024).toFixed(2),
      uptimeSec: +process.uptime().toFixed(2),
    },
    eventLoopDelayMs: {
      min: +toMs(h.min).toFixed(3),
      p50: +toMs(h.percentile(50)).toFixed(3),
      p99: +toMs(h.percentile(99)).toFixed(3),
      max: +toMs(h.max).toFixed(3),
      mean: +toMs(h.mean).toFixed(3),
    },
    cpu: {
      userMs: +(cpu.user / 1000).toFixed(2),
      systemMs: +(cpu.system / 1000).toFixed(2),
    },
    resources,
    metricsModule: {
      present: fs.existsSync(path.join(root, 'src/utils/metrics.ts')),
      defaultMetricsPrefix: /collectDefaultMetrics\(\{\s*register:\s*metricsRegistry,\s*prefix:\s*'vbot_'/.test(
        read('src/utils/metrics.ts'),
      ),
      aiLatencyHistogram: /aiProviderLatencyHistogram/.test(read('src/utils/metrics.ts')),
      dbQueryHistogram: /dbQueryHistogram/.test(read('src/utils/metrics.ts')),
    },
    residual: [
      'Idle/probe process only — not full bot + Discord gateway production RSS',
      'GC pause histogram not exposed without --expose-gc',
    ],
  };
}

async function sampleStage47() {
  const prismaSrc = read('src/database/prisma.ts');
  const pkg = JSON.parse(read('package.json'));
  const schema = read('prisma/schema.prisma');
  const out = {
    stage: 47,
    kind: 'data-plane-baseline',
    contracts: {
      prismaPoolMax10: /max:\s*10/.test(prismaSrc),
      connectionLimitDefault10: /connection_limit/.test(prismaSrc) && /'10'|"10"/.test(prismaSrc),
      poolTimeoutDefault20: /pool_timeout/.test(prismaSrc),
      transactionMaxWait5s: /maxWait:\s*5_000/.test(prismaSrc),
      transactionTimeout15s: /timeout:\s*15_000/.test(prismaSrc),
      queryLatencyHook: /recordPrismaLatency/.test(prismaSrc),
      redisDep: Boolean(pkg.dependencies?.redis || pkg.dependencies?.ioredis),
      redisEnvExample: /REDIS_URL/.test(read('.env.example')),
      nitradoJobModel: /model NitradoJob/.test(schema),
      workerSurface: fs.existsSync(path.join(root, 'src/modules/nitrado/jobWorker.ts')),
    },
    live: {
      database: { attempted: false },
      redis: { attempted: false },
    },
    residual: [],
  };

  if (process.env.DATABASE_URL) {
    out.live.database.attempted = true;
    const t0 = performance.now();
    try {
      const pg = await import('pg');
      const client = new pg.default.Client({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5_000,
      });
      await client.connect();
      const r = await client.query('SELECT 1 AS ok');
      await client.end();
      out.live.database = {
        attempted: true,
        ok: r.rows?.[0]?.ok === 1,
        latencyMs: +((performance.now() - t0).toFixed(2)),
      };
    } catch (e) {
      out.live.database = {
        attempted: true,
        ok: false,
        latencyMs: +((performance.now() - t0).toFixed(2)),
        error: String(e?.message || e).slice(0, 200),
      };
      out.residual.push('DATABASE_URL set but live probe failed');
    }
  } else {
    out.residual.push('No DATABASE_URL — live DB latency not measured on this host');
  }

  if (process.env.REDIS_URL) {
    out.live.redis.attempted = true;
    const t0 = performance.now();
    try {
      const Redis = (await import('redis')).createClient;
      const client = Redis({ url: process.env.REDIS_URL, socket: { connectTimeout: 5_000 } });
      await client.connect();
      const pong = await client.ping();
      await client.quit();
      out.live.redis = {
        attempted: true,
        ok: pong === 'PONG',
        latencyMs: +((performance.now() - t0).toFixed(2)),
      };
    } catch (e) {
      out.live.redis = {
        attempted: true,
        ok: false,
        latencyMs: +((performance.now() - t0).toFixed(2)),
        error: String(e?.message || e).slice(0, 200),
      };
      out.residual.push('REDIS_URL set but live probe failed');
    }
  } else {
    out.residual.push('No REDIS_URL — live Redis latency not measured on this host');
  }

  const allContracts = Object.values(out.contracts).every(Boolean);
  out.contractsOk = allContracts;
  if (!allContracts) {
    throw new Error('Stage 47 structural contracts failed: ' + JSON.stringify(out.contracts));
  }
  return out;
}

async function sampleStage48() {
  const nitradoClient = read('src/modules/nitrado/nitradoClient.ts');
  const circuit = read('src/modules/nitrado/circuitBreaker.ts');
  const aiHandler = read('src/modules/ai/aiHandler.ts');
  const metrics = read('src/utils/metrics.ts');

  // Synthetic latency histogram (local only — not external provider RTT)
  const samples = [];
  for (let i = 0; i < 40; i++) {
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 2 + (i % 5)));
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];

  const out = {
    stage: 48,
    kind: 'external-deps-baseline',
    contracts: {
      nitradoHttpTimeout15s: /timeout:\s*15_000/.test(nitradoClient),
      nitradoRetryBounded3: /attempt <= 3/.test(nitradoClient),
      nitrado429RetryAfter: /parseRetryAfterMs/.test(nitradoClient) && /429/.test(nitradoClient),
      nitradoCircuitBreaker: /NitradoCircuitBreaker/.test(circuit) && /HALF_OPEN/.test(circuit),
      aiProviderTimeout30s: /timeout:\s*30000/.test(aiHandler),
      ai429Handling: /is429/.test(aiHandler) && /rateLimit/.test(aiHandler),
      aiTransientRetry: /transient && attempt === 1/.test(aiHandler),
      aiFallbackMetrics: /aiFallbackCounter/.test(metrics),
      aiLatencyHistogram: /aiProviderLatencyHistogram/.test(metrics),
      economyScopeGuardIntact: /requireSafeDashboardEconomyScope/.test(
        read('src/dashboard/middleware/economyScopeGuard.ts'),
      ),
    },
    syntheticLocalTimerMs: {
      n: samples.length,
      p50: +pct(50).toFixed(3),
      p95: +pct(95).toFixed(3),
      p99: +pct(99).toFixed(3),
      note: 'local setTimeout jitter only — not live AI/Nitrado RTT',
    },
    residual: [
      'No live AI provider calls (would need credentials + network policy)',
      'No live Nitrado API calls (would need token + rate budget)',
      'Circuit breaker behavior covered by unit tests; this probe pins source contracts',
    ],
  };
  out.contractsOk = Object.values(out.contracts).every(Boolean);
  if (!out.contractsOk) {
    throw new Error('Stage 48 structural contracts failed: ' + JSON.stringify(out.contracts));
  }
  return out;
}

const sampleMs = Number(process.env.RUNTIME_BASELINE_MS ?? 1500);
const sha = gitSha();
const capturedAt = new Date().toISOString();

const stage46 = await sampleStage46(sampleMs);
const stage47 = await sampleStage47();
const stage48 = await sampleStage48();

const envelope = {
  exactSha: sha,
  capturedAt,
  host: {
    platform: process.platform,
    node: process.version,
    cwd: root,
  },
  stages: { 46: stage46, 47: stage47, 48: stage48 },
};

console.log(JSON.stringify(envelope, null, 2));

if (process.env.WRITE_PERF_ARTIFACTS !== '0') {
  const dir = path.join(root, 'docs/audit/performance', sha);
  fs.mkdirSync(dir, { recursive: true });
  const write = (name, obj) => {
    const body = { exactSha: sha, capturedAt, ...obj };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(body, null, 2) + '\n', 'utf8');
  };
  write('46-runtime-baseline.json', stage46);
  write('47-data-plane.json', stage47);
  write('48-external-deps.json', stage48);
  fs.writeFileSync(path.join(dir, 'wave-e-envelope.json'), JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  // latest pointer (not a substitute for SHA dir)
  fs.writeFileSync(
    path.join(root, 'docs/audit/performance/LATEST_WAVE_E.json'),
    JSON.stringify({ exactSha: sha, capturedAt, dir: `docs/audit/performance/${sha}` }, null, 2) + '\n',
    'utf8',
  );
}
