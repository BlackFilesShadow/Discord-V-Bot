/**
 * Stage 51 — multi-hour full-stack soak.
 *
 * Keeps the production dashboard runtime alive under stable loopback HTTP load
 * while sampling live PostgreSQL, Redis, worker-queue state, event-loop delay,
 * memory and active resources. Mandatory CI evidence rejects short durations.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { createClient, type RedisClientType } from 'redis';

type RouteName = 'liveness' | 'readiness' | 'authDenied';

type QueueDepths = Record<string, number>;

interface HttpWindow {
  requests: number;
  passed: number;
  errors: number;
  latencyMs: number[];
}

interface SoakSample {
  index: number;
  elapsedMs: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeResources: number;
  activeResourcesByType: Record<string, number>;
  legacyHandles: number;
  listeners: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  http: {
    requests: number;
    passed: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
  };
  postgres: {
    probeP99Ms: number;
    poolTotal: number;
    poolIdle: number;
    poolWaiting: number;
    databaseConnections: number;
  };
  redis: {
    pingMs: number;
    connectedClients: number | null;
  };
  queue: {
    depths: QueueDepths;
    activeDepth: number;
    deadDepth: number;
    oldestPendingAgeSeconds: number;
  };
}

const root = process.cwd();
const mandatoryMultiHour = process.env.STAGE51_REQUIRE_MULTI_HOUR === '1';
const durationMs = boundedInteger(process.env.STAGE51_DURATION_MS, mandatoryMultiHour ? 7_200_000 : 120_000, 60_000, 18_000_000);
const sampleIntervalMs = boundedInteger(process.env.STAGE51_SAMPLE_INTERVAL_MS, 60_000, 5_000, 300_000);
const concurrency = boundedInteger(process.env.STAGE51_CONCURRENCY, 4, 2, 16);
const requestTimeoutMs = boundedInteger(process.env.STAGE51_REQUEST_TIMEOUT_MS, 3_000, 500, 10_000);
const recoveryEverySamples = boundedInteger(process.env.STAGE51_RECOVERY_EVERY_SAMPLES, 30, 5, 120);
const httpP99LimitMs = boundedInteger(process.env.STAGE51_HTTP_P99_LIMIT_MS, 2_000, 250, 10_000);
const eventLoopP99LimitMs = boundedInteger(process.env.STAGE51_EVENT_LOOP_P99_LIMIT_MS, 500, 50, 2_000);
const dbP99LimitMs = boundedInteger(process.env.STAGE51_DB_P99_LIMIT_MS, 1_000, 100, 5_000);
const redisPingLimitMs = boundedInteger(process.env.STAGE51_REDIS_PING_LIMIT_MS, 1_000, 100, 5_000);
const heapSlopeLimitMbPerHour = boundedNumber(process.env.STAGE51_HEAP_SLOPE_LIMIT_MB_PER_HOUR, 64, 1, 1024);
const rssSlopeLimitMbPerHour = boundedNumber(process.env.STAGE51_RSS_SLOPE_LIMIT_MB_PER_HOUR, 128, 1, 2048);
const resourceSlopeLimitPerHour = boundedNumber(process.env.STAGE51_RESOURCE_SLOPE_LIMIT_PER_HOUR, 6, 0, 100);
const listenerSlopeLimitPerHour = boundedNumber(process.env.STAGE51_LISTENER_SLOPE_LIMIT_PER_HOUR, 2, 0, 100);

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function boundedNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Stage 51 contract failed: ${message}`);
}

function exactSha(): string {
  const sha = process.env.STAGE51_EXACT_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assertContract(/^[0-9a-f]{40}$/i.test(sha), 'exact SHA must contain 40 hexadecimal characters');
  return sha;
}

function setRuntimeEnvironment(tempRoot: string): void {
  const defaults: Record<string, string> = {
    DISCORD_TOKEN: ['stage', '51', 'token'].join('-'),
    DISCORD_CLIENT_ID: '1'.repeat(18),
    DISCORD_CLIENT_SECRET: ['stage', '51', 'client'].join('-'),
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

function activeResourceSnapshot(): { count: number; byType: Record<string, number>; legacyHandles: number; listeners: number } {
  const byType: Record<string, number> = {};
  if (typeof process.getActiveResourcesInfo === 'function') {
    for (const type of process.getActiveResourcesInfo()) byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    count: Object.values(byType).reduce((sum, value) => sum + value, 0),
    byType,
    legacyHandles: process._getActiveHandles?.().length ?? 0,
    listeners: ['warning', 'uncaughtException', 'unhandledRejection']
      .reduce((sum, event) => sum + process.listenerCount(event), 0),
  };
}

function linearSlopePerHour(samples: SoakSample[], selector: (sample: SoakSample) => number): number {
  if (samples.length < 2) return 0;
  const startMs = samples[0].elapsedMs;
  const xs = samples.map(sample => (sample.elapsedMs - startMs) / 3_600_000);
  const ys = samples.map(selector);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < xs.length; index += 1) {
    numerator += (xs[index] - xMean) * (ys[index] - yMean);
    denominator += (xs[index] - xMean) ** 2;
  }
  return denominator === 0 ? 0 : round(numerator / denominator, 4);
}

function routeFor(workerId: number, iteration: number): RouteName {
  const slot = (workerId + iteration) % 20;
  if (slot === 0) return 'authDenied';
  if (slot <= 9) return 'readiness';
  return 'liveness';
}

function routePath(route: RouteName): string {
  if (route === 'liveness') return '/health';
  if (route === 'readiness') return '/health/ready';
  return '/api/v2/dev/status';
}

async function executeRequest(origin: string, route: RouteName): Promise<{ ok: boolean; latencyMs: number }> {
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${routePath(route)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'vbot-stage51-soak-probe' },
    });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* contract fails below */ }
    const checks = body.checks as Record<string, unknown> | undefined;
    const ok = route === 'liveness'
      ? response.status === 200 && body.status === 'ok'
      : route === 'readiness'
        ? response.status === 200 && body.status === 'ready' && checks?.database === 'ok' && checks?.sessionStore === 'ok'
        : response.status === 401;
    return { ok, latencyMs: performance.now() - started };
  } catch {
    return { ok: false, latencyMs: performance.now() - started };
  }
}

async function databaseProbe(pool: Pool): Promise<{ p99Ms: number; connections: number }> {
  const latencies: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    assertContract(result.rows[0]?.ok === 1, 'PostgreSQL SELECT 1 must succeed');
    latencies.push(performance.now() - started);
  }
  const connections = await pool.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
  );
  return { p99Ms: percentile(latencies, 0.99), connections: Number(connections.rows[0]?.count ?? 0) };
}

async function queueProbe(pool: Pool): Promise<{ depths: QueueDepths; activeDepth: number; deadDepth: number; oldestPendingAgeSeconds: number }> {
  const depthResult = await pool.query<{ status: string; count: number }>(
    'SELECT "status"::text AS status, COUNT(*)::int AS count FROM "NitradoJob" GROUP BY "status"',
  );
  const depths = Object.fromEntries(depthResult.rows.map(row => [row.status, Number(row.count)]));
  const oldestResult = await pool.query<{ age: number | null }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::float8 AS age
       FROM "NitradoJob" WHERE "status" = 'PENDING'`,
  );
  return {
    depths,
    activeDepth: Number(depths.PENDING ?? 0) + Number(depths.RUNNING ?? 0),
    deadDepth: Number(depths.DEAD ?? 0),
    oldestPendingAgeSeconds: round(Number(oldestResult.rows[0]?.age ?? 0)),
  };
}

function redisConnectedClients(info: string): number | null {
  const match = /^connected_clients:(\d+)$/m.exec(info);
  return match ? Number(match[1]) : null;
}

async function redisProbe(client: RedisClientType): Promise<{ pingMs: number; connectedClients: number | null }> {
  const started = performance.now();
  const pong = await client.ping();
  assertContract(pong === 'PONG', 'Redis PING must return PONG');
  const pingMs = performance.now() - started;
  return { pingMs: round(pingMs), connectedClients: redisConnectedClients(await client.info('clients')) };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  assertContract(databaseUrl, 'DATABASE_URL is required');
  assertContract(redisUrl, 'REDIS_URL is required');
  if (mandatoryMultiHour) {
    assertContract(durationMs >= 7_200_000, 'mandatory evidence must run for at least two hours');
    assertContract(sampleIntervalMs <= 60_000, 'mandatory evidence must sample at least once per minute');
  }

  const sha = exactSha();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-stage51-'));
  setRuntimeEnvironment(tempRoot);

  const { startDashboard } = require('../src/dashboard/server') as typeof import('../src/dashboard/server');
  const prisma = (require('../src/database/prisma') as typeof import('../src/database/prisma')).default;
  const observerPool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
    application_name: 'vbot-stage51-observer',
  });
  const redis = createClient({ url: redisUrl, socket: { connectTimeout: 5_000, reconnectStrategy: false } });
  const redisErrors: string[] = [];
  redis.on('error', error => redisErrors.push(error.message));
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let runtime: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let stopped = false;
  let loadStop = false;
  let window: HttpWindow = { requests: 0, passed: 0, errors: 0, latencyMs: [] };
  let totalRequests = 0;
  let totalErrors = 0;
  const samples: SoakSample[] = [];
  const recoveryEvents: Array<{ index: number; postgresRecycleOk: boolean; redisReconnectOk: boolean }> = [];

  try {
    await redis.connect();
    runtime = await startDashboard(undefined, { port: 0, host: '127.0.0.1' });
    const address = runtime.address();
    assertContract(address && typeof address === 'object' && address.address === '127.0.0.1', 'dashboard must bind to loopback');
    const origin = `http://127.0.0.1:${address.port}`;

    const preflight = await Promise.all([
      executeRequest(origin, 'liveness'),
      executeRequest(origin, 'readiness'),
      executeRequest(origin, 'authDenied'),
    ]);
    assertContract(preflight.every(result => result.ok), 'dashboard preflight must pass');
    await databaseProbe(observerPool);
    await redisProbe(redis);

    eventLoop.enable();
    const startedAt = performance.now();
    const deadline = startedAt + durationMs;
    const workers = Promise.all(Array.from({ length: concurrency }, async (_, workerId) => {
      let iteration = 0;
      while (!loadStop && performance.now() < deadline) {
        const result = await executeRequest(origin, routeFor(workerId, iteration));
        totalRequests += 1;
        window.requests += 1;
        window.latencyMs.push(result.latencyMs);
        if (result.ok) {
          window.passed += 1;
        } else {
          window.errors += 1;
          totalErrors += 1;
        }
        iteration += 1;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }));

    let nextSampleAt = Math.min(deadline, startedAt + sampleIntervalMs);
    let sampleIndex = 0;
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.max(50, nextSampleAt - performance.now())));
      const elapsedMs = performance.now() - startedAt;
      const memory = process.memoryUsage();
      const active = activeResourceSnapshot();
      const db = await databaseProbe(observerPool);
      const redisState = await redisProbe(redis);
      const queue = await queueProbe(observerPool);
      const latencies = window.latencyMs;
      const httpErrors = window.errors;
      const httpRequests = window.requests;
      const eventLoopP99Ms = round(eventLoop.percentile(99) / 1_000_000);
      const eventLoopMaxMs = round(eventLoop.max / 1_000_000);
      eventLoop.reset();

      samples.push({
        index: sampleIndex,
        elapsedMs: round(elapsedMs),
        rssMb: round(memory.rss / 1024 / 1024),
        heapUsedMb: round(memory.heapUsed / 1024 / 1024),
        heapTotalMb: round(memory.heapTotal / 1024 / 1024),
        externalMb: round(memory.external / 1024 / 1024),
        arrayBuffersMb: round(memory.arrayBuffers / 1024 / 1024),
        activeResources: active.count,
        activeResourcesByType: active.byType,
        legacyHandles: active.legacyHandles,
        listeners: active.listeners,
        eventLoopP99Ms,
        eventLoopMaxMs,
        http: {
          requests: httpRequests,
          passed: window.passed,
          errors: httpErrors,
          errorRate: httpRequests > 0 ? round(httpErrors / httpRequests, 6) : 1,
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          p99Ms: percentile(latencies, 0.99),
          maxMs: round(Math.max(0, ...latencies)),
        },
        postgres: {
          probeP99Ms: db.p99Ms,
          poolTotal: observerPool.totalCount,
          poolIdle: observerPool.idleCount,
          poolWaiting: observerPool.waitingCount,
          databaseConnections: db.connections,
        },
        redis: redisState,
        queue,
      });
      window = { requests: 0, passed: 0, errors: 0, latencyMs: [] };

      sampleIndex += 1;
      if (sampleIndex % recoveryEverySamples === 0 && performance.now() + 10_000 < deadline) {
        let postgresRecycleOk = false;
        let redisReconnectOk = false;
        try {
          const client = await observerPool.connect();
          await client.query('SELECT 1');
          client.release(true);
          postgresRecycleOk = (await observerPool.query<{ ok: number }>('SELECT 1 AS ok')).rows[0]?.ok === 1;
        } catch { postgresRecycleOk = false; }
        try {
          await redis.quit();
          await redis.connect();
          redisReconnectOk = (await redis.ping()) === 'PONG';
        } catch { redisReconnectOk = false; }
        recoveryEvents.push({ index: sampleIndex, postgresRecycleOk, redisReconnectOk });
      }
      nextSampleAt = Math.min(deadline, nextSampleAt + sampleIntervalMs);
    }

    loadStop = true;
    await workers;
    eventLoop.disable();

    const warmupDrop = Math.min(Math.max(1, Math.floor(samples.length * 0.1)), Math.max(0, samples.length - 2));
    const steadySamples = samples.slice(warmupDrop);
    const heapSlopeMbPerHour = linearSlopePerHour(steadySamples, sample => sample.heapUsedMb);
    const rssSlopeMbPerHour = linearSlopePerHour(steadySamples, sample => sample.rssMb);
    const resourceSlopePerHour = linearSlopePerHour(steadySamples, sample => sample.activeResources);
    const listenerSlopePerHour = linearSlopePerHour(steadySamples, sample => sample.listeners);
    const databaseConnectionSlopePerHour = linearSlopePerHour(steadySamples, sample => sample.postgres.databaseConnections);
    const queueActiveSlopePerHour = linearSlopePerHour(steadySamples, sample => sample.queue.activeDepth);
    const expectedSamples = Math.floor(durationMs / sampleIntervalMs);
    const totalErrorRate = totalRequests > 0 ? totalErrors / totalRequests : 1;

    const gates = {
      mandatoryDuration: !mandatoryMultiHour || durationMs >= 7_200_000,
      sampleCoverage: samples.length >= Math.max(2, Math.floor(expectedSamples * 0.95)),
      httpRequestsObserved: totalRequests >= concurrency * 100,
      httpErrorRate: totalErrorRate <= 0.01,
      httpWindowP99: steadySamples.every(sample => sample.http.p99Ms <= httpP99LimitMs),
      readinessStable: steadySamples.every(sample => sample.http.requests > 0 && sample.http.errorRate <= 0.01),
      eventLoopStable: steadySamples.every(sample => sample.eventLoopP99Ms <= eventLoopP99LimitMs),
      postgresStable: steadySamples.every(sample => sample.postgres.probeP99Ms <= dbP99LimitMs && sample.postgres.poolWaiting === 0),
      redisStable: steadySamples.every(sample => sample.redis.pingMs <= redisPingLimitMs),
      redisNoErrors: redisErrors.length === 0,
      heapSlope: heapSlopeMbPerHour <= heapSlopeLimitMbPerHour,
      rssSlope: rssSlopeMbPerHour <= rssSlopeLimitMbPerHour,
      activeResourceSlope: resourceSlopePerHour <= resourceSlopeLimitPerHour,
      listenerSlope: listenerSlopePerHour <= listenerSlopeLimitPerHour,
      databaseConnectionSlope: databaseConnectionSlopePerHour <= 2,
      queueDoesNotGrow: queueActiveSlopePerHour <= 0.5,
      queueDeadDoesNotGrow: steadySamples.length < 2 || steadySamples.at(-1)!.queue.deadDepth <= steadySamples[0].queue.deadDepth,
      recovery: recoveryEvents.length > 0 && recoveryEvents.every(event => event.postgresRecycleOk && event.redisReconnectOk),
    };
    const passed = Object.values(gates).every(Boolean);

    await runtime.stop();
    runtime = undefined;
    await prisma.$disconnect();
    if (redis.isOpen) await redis.quit();
    await observerPool.end();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    stopped = true;

    const artifact = {
      schemaVersion: 1,
      stage: 51,
      exactSha: sha,
      capturedAt: new Date().toISOString(),
      environment: {
        transport: 'production dashboard over real TCP loopback',
        database: 'live PostgreSQL via redacted DATABASE_URL',
        redis: 'live Redis via redacted REDIS_URL',
        externalNetworkUsed: false,
        node: process.version,
        platform: process.platform,
        cpuCount: os.cpus().length,
      },
      config: { durationMs, sampleIntervalMs, concurrency, requestTimeoutMs, recoveryEverySamples, mandatoryMultiHour },
      thresholds: {
        minimumMandatoryDurationMs: 7_200_000,
        httpP99LimitMs,
        maximumHttpErrorRate: 0.01,
        eventLoopP99LimitMs,
        dbP99LimitMs,
        redisPingLimitMs,
        heapSlopeLimitMbPerHour,
        rssSlopeLimitMbPerHour,
        resourceSlopeLimitPerHour,
        listenerSlopeLimitPerHour,
      },
      totals: { requests: totalRequests, errors: totalErrors, errorRate: round(totalErrorRate, 6), samples: samples.length },
      trends: {
        warmupSamplesDropped: warmupDrop,
        steadySamples: steadySamples.length,
        heapSlopeMbPerHour,
        rssSlopeMbPerHour,
        activeResourceSlopePerHour: resourceSlopePerHour,
        listenerSlopePerHour,
        databaseConnectionSlopePerHour,
        queueActiveSlopePerHour,
      },
      recoveryEvents,
      redisErrors,
      samples,
      gates,
      residual: [],
      passed,
    };

    const outputPath = path.resolve(root, process.env.STAGE51_OUTPUT_PATH ?? `stage51-artifacts/${sha}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ stage: 51, passed, exactSha: sha, outputPath, samples: samples.length })}\n`);
    assertContract(passed, `soak gates failed: ${JSON.stringify(gates)}`);
  } finally {
    loadStop = true;
    eventLoop.disable();
    if (!stopped) {
      if (runtime) await runtime.stop().catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
      if (redis.isOpen) await redis.quit().catch(() => undefined);
      await observerPool.end().catch(() => undefined);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

void main().catch(error => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
