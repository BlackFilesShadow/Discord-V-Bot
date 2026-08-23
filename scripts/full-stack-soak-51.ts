import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Pool } from 'pg';

type Route = 'health' | 'ready' | 'authDenied';

type Sample = {
  elapsedMs: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeResources: number;
  dbConnections: number;
};

const root = process.cwd();
const durationMs = bounded(process.env.STAGE51_DURATION_MS, 7_200_000, 7_200_000, 14_400_000);
const concurrency = bounded(process.env.STAGE51_CONCURRENCY, 4, 2, 16);
const sampleIntervalMs = bounded(process.env.STAGE51_SAMPLE_INTERVAL_MS, 10_000, 5_000, 60_000);
const requestTimeoutMs = bounded(process.env.STAGE51_REQUEST_TIMEOUT_MS, 5_000, 1_000, 15_000);

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function exactSha(): string {
  const value = process.env.STAGE51_EXACT_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error('Stage 51 exact SHA is invalid');
  return value;
}

function mb(bytes: number): number {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)].toFixed(3));
}

function median(values: number[]): number {
  return percentile(values, 0.5);
}

function runtimeEnv(tempRoot: string): void {
  const defaults: Record<string, string> = {
    DISCORD_TOKEN: 'stage-51-token',
    DISCORD_CLIENT_ID: '1'.repeat(18),
    DISCORD_CLIENT_SECRET: 'stage-51-client',
    BOT_OWNER_ID: '1'.repeat(18),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'warn';
  process.env.TRUST_PROXY = 'false';
  process.env.DASHBOARD_URL = 'http://127.0.0.1';
  process.env.OAUTH2_REDIRECT_URI = 'http://127.0.0.1/auth/callback';
  process.env.METRICS_ENABLED = 'false';
  process.env.MEMBER_SYNC_ENABLED = 'false';
  process.env.UPLOAD_DIR = path.join(tempRoot, 'uploads');
  process.env.PRIVATE_UPLOAD_DIR = path.join(tempRoot, 'private');
  process.env.DEV_UPLOAD_DIR = path.join(tempRoot, 'private', 'dev-logs');
  process.env.EXPORT_DIR = path.join(tempRoot, 'private', 'exports');
  process.env.LOG_DIR = path.join(tempRoot, 'logs');
}

async function request(origin: string, route: Route): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const started = performance.now();
  const target = route === 'health' ? '/health' : route === 'ready' ? '/health/ready' : '/api/v2/dev/status';
  try {
    const response = await fetch(`${origin}${target}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'vbot-stage51-soak' },
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* fail closed below */ }
    const checks = body.checks as Record<string, unknown> | undefined;
    const ok = route === 'health'
      ? response.status === 200 && body.status === 'ok'
      : route === 'ready'
        ? response.status === 200 && body.status === 'ready' && checks?.database === 'ok' && checks?.sessionStore === 'ok'
        : response.status === 401;
    return { ok, latencyMs: performance.now() - started, status: response.status };
  } catch {
    return { ok: false, latencyMs: performance.now() - started, status: 0 };
  }
}

async function main(): Promise<void> {
  if (process.env.STAGE51_REQUIRE_LIVE !== '1') throw new Error('STAGE51_REQUIRE_LIVE=1 is mandatory');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is mandatory');

  const sha = exactSha();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-stage51-'));
  runtimeEnv(tempRoot);

  const { startDashboard } = require('../src/dashboard/server') as typeof import('../src/dashboard/server');
  const prisma = (require('../src/database/prisma') as typeof import('../src/database/prisma')).default;
  const observer = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, allowExitOnIdle: true });
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let server: Awaited<ReturnType<typeof startDashboard>> | undefined;

  const samples: Sample[] = [];
  const latencies: number[] = [];
  const statusCounts: Record<string, number> = {};
  let requests = 0;
  let failures = 0;
  let stop = false;

  try {
    await observer.query('SELECT 1');
    server = await startDashboard(undefined, { host: '127.0.0.1', port: 0 });
    const address = server.address();
    if (!address || typeof address !== 'object' || address.address !== '127.0.0.1') {
      throw new Error('Stage 51 dashboard must bind to ephemeral loopback');
    }
    const origin = `http://127.0.0.1:${address.port}`;

    for (const route of ['health', 'ready', 'authDenied'] as const) {
      const result = await request(origin, route);
      if (!result.ok) throw new Error(`Stage 51 preflight failed: ${route}/${result.status}`);
    }

    const started = performance.now();
    const deadline = started + durationMs;
    eventLoop.enable();

    const sampler = (async () => {
      while (!stop) {
        const mem = process.memoryUsage();
        const db = await observer.query<{ count: number }>(
          'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
        );
        samples.push({
          elapsedMs: Math.round(performance.now() - started),
          rssMb: mb(mem.rss),
          heapUsedMb: mb(mem.heapUsed),
          heapTotalMb: mb(mem.heapTotal),
          externalMb: mb(mem.external),
          arrayBuffersMb: mb(mem.arrayBuffers),
          activeResources: process.getActiveResourcesInfo().length,
          dbConnections: Number(db.rows[0]?.count ?? 0),
        });
        await new Promise(resolve => setTimeout(resolve, sampleIntervalMs));
      }
    })();

    await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
      let iteration = worker;
      while (performance.now() < deadline) {
        const route: Route = iteration % 20 === 0 ? 'authDenied' : iteration % 2 === 0 ? 'ready' : 'health';
        const result = await request(origin, route);
        requests += 1;
        latencies.push(result.latencyMs);
        statusCounts[String(result.status)] = (statusCounts[String(result.status)] ?? 0) + 1;
        if (!result.ok) failures += 1;
        iteration += concurrency;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }));

    stop = true;
    await sampler;
    eventLoop.disable();

    const window = Math.max(3, Math.floor(samples.length * 0.1));
    const earlyHeap = median(samples.slice(0, window).map(sample => sample.heapUsedMb));
    const lateHeap = median(samples.slice(-window).map(sample => sample.heapUsedMb));
    const earlyRss = median(samples.slice(0, window).map(sample => sample.rssMb));
    const lateRss = median(samples.slice(-window).map(sample => sample.rssMb));
    const heapGrowthMb = Number((lateHeap - earlyHeap).toFixed(2));
    const rssGrowthMb = Number((lateRss - earlyRss).toFixed(2));
    const errorRate = requests === 0 ? 1 : failures / requests;

    const gates = {
      duration: durationMs >= 7_200_000,
      enoughSamples: samples.length >= 600,
      enoughTraffic: requests >= 10_000,
      failClosed: (statusCounts['401'] ?? 0) > 0,
      errorRate: errorRate <= 0.001,
      httpP99: percentile(latencies, 0.99) <= 2_000,
      eventLoopP99: eventLoop.percentile(99) / 1_000_000 <= 500,
      heapGrowth: heapGrowthMb <= Math.max(64, earlyHeap * 0.25),
      rssGrowth: rssGrowthMb <= Math.max(128, earlyRss * 0.25),
      dbConnections: Math.max(...samples.map(sample => sample.dbConnections)) <= 30,
      activeResources: Math.max(...samples.map(sample => sample.activeResources)) <= 128,
    };

    const envelope = {
      stage: 51,
      kind: 'production-dashboard-postgresql-multi-hour-soak',
      exactSha: sha,
      capturedAt: new Date().toISOString(),
      durationMs,
      concurrency,
      sampleIntervalMs,
      requests,
      failures,
      errorRate,
      httpLatency: { p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), p99Ms: percentile(latencies, 0.99) },
      eventLoop: { p99Ms: Number((eventLoop.percentile(99) / 1_000_000).toFixed(3)), maxMs: Number((eventLoop.max / 1_000_000).toFixed(3)) },
      memory: { earlyHeapMb: earlyHeap, lateHeapMb: lateHeap, heapGrowthMb, earlyRssMb: earlyRss, lateRssMb: lateRss, rssGrowthMb },
      maxima: {
        rssMb: Math.max(...samples.map(sample => sample.rssMb)),
        heapUsedMb: Math.max(...samples.map(sample => sample.heapUsedMb)),
        activeResources: Math.max(...samples.map(sample => sample.activeResources)),
        dbConnections: Math.max(...samples.map(sample => sample.dbConnections)),
      },
      statusCounts,
      sampleCount: samples.length,
      gates,
      samples,
    };

    const output = process.env.STAGE51_OUTPUT_PATH ?? path.join('stage51-artifacts', `${sha}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(envelope, null, 2) + '\n');
    console.log(JSON.stringify({ ...envelope, samples: `[${samples.length} samples]` }, null, 2));

    if (Object.values(gates).some(value => !value)) process.exitCode = 2;
  } finally {
    stop = true;
    eventLoop.disable();
    if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    await observer.end().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
