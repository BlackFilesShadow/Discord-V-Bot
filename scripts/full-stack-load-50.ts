/**
 * Stage 50 — production dashboard + live PostgreSQL load baseline.
 *
 * This probe starts the real dashboard runtime on an ephemeral loopback port.
 * It loads liveness, DB-backed readiness and the unauthenticated API guard
 * while measuring HTTP, process, event-loop and PostgreSQL behaviour.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Pool } from 'pg';

type RouteName = 'liveness' | 'readiness' | 'authDenied';

interface RequestSample {
  route: RouteName;
  latencyMs: number;
  status: number;
  ok: boolean;
  error?: string;
}

interface DatabaseSnapshot {
  xactCommit: number;
  xactRollback: number;
  blocksRead: number;
  blocksHit: number;
  tuplesReturned: number;
  connections: number;
}

const root = process.cwd();
const durationMs = boundedInteger(process.env.STAGE50_DURATION_MS, 2_500, 1_000, 30_000);
const concurrency = boundedInteger(process.env.STAGE50_CONCURRENCY, 20, 8, 64);
const requestTimeoutMs = boundedInteger(process.env.STAGE50_REQUEST_TIMEOUT_MS, 3_000, 500, 10_000);
const httpP99LimitMs = boundedInteger(process.env.STAGE50_HTTP_P99_LIMIT_MS, 2_000, 250, 10_000);
const dbP99LimitMs = boundedInteger(process.env.STAGE50_DB_P99_LIMIT_MS, 1_000, 100, 5_000);
const eventLoopP99LimitMs = boundedInteger(process.env.STAGE50_EVENT_LOOP_P99_LIMIT_MS, 500, 50, 2_000);

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

function distribution(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: round(sorted[0] ?? 0),
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Stage 50 contract failed: ${message}`);
}

function exactSha(): string {
  const sha = process.env.STAGE50_EXACT_SHA
    ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assertContract(/^[0-9a-f]{40}$/i.test(sha), 'exact SHA must contain 40 hexadecimal characters');
  return sha;
}

function setRuntimeEnvironment(tempRoot: string): void {
  const defaults: Record<string, string> = {
    DISCORD_TOKEN: ['stage', '50', 'token'].join('-'),
    DISCORD_CLIENT_ID: '1'.repeat(18),
    DISCORD_CLIENT_SECRET: ['stage', '50', 'client'].join('-'),
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

async function databaseSnapshot(pool: Pool): Promise<DatabaseSnapshot> {
  const result = await pool.query<{
    xact_commit: string;
    xact_rollback: string;
    blks_read: string;
    blks_hit: string;
    tup_returned: string;
    numbackends: number;
  }>(`SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, numbackends
       FROM pg_stat_database WHERE datname = current_database()`);
  const row = result.rows[0];
  assertContract(row, 'pg_stat_database must expose the current database');
  return {
    xactCommit: Number(row.xact_commit),
    xactRollback: Number(row.xact_rollback),
    blocksRead: Number(row.blks_read),
    blocksHit: Number(row.blks_hit),
    tuplesReturned: Number(row.tup_returned),
    connections: Number(row.numbackends),
  };
}

function snapshotDelta(after: DatabaseSnapshot, before: DatabaseSnapshot): DatabaseSnapshot {
  return {
    xactCommit: Math.max(0, after.xactCommit - before.xactCommit),
    xactRollback: Math.max(0, after.xactRollback - before.xactRollback),
    blocksRead: Math.max(0, after.blocksRead - before.blocksRead),
    blocksHit: Math.max(0, after.blocksHit - before.blocksHit),
    tuplesReturned: Math.max(0, after.tuplesReturned - before.tuplesReturned),
    connections: after.connections,
  };
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

async function executeRequest(origin: string, route: RouteName): Promise<RequestSample> {
  const started = performance.now();
  try {
    const response = await fetch(`${origin}${routePath(route)}`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
      headers: { accept: 'application/json', 'user-agent': 'vbot-stage50-load-probe' },
    });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try { body = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* contract fails below */ }
    const checks = body.checks as Record<string, unknown> | undefined;
    const ok = route === 'liveness'
      ? response.status === 200 && body.status === 'ok'
      : route === 'readiness'
        ? response.status === 200 && body.status === 'ready'
          && checks?.database === 'ok' && checks?.sessionStore === 'ok'
        : response.status === 401;
    return { route, latencyMs: performance.now() - started, status: response.status, ok };
  } catch (error) {
    return {
      route,
      latencyMs: performance.now() - started,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}

function valuesForRoute(samples: RequestSample[], route: RouteName): number[] {
  return samples.filter(sample => sample.route === route).map(sample => sample.latencyMs);
}

async function main(): Promise<void> {
  assertContract(process.env.STAGE50_REQUIRE_LIVE === '1', 'STAGE50_REQUIRE_LIVE=1 is mandatory');
  const databaseUrl = process.env.DATABASE_URL;
  assertContract(databaseUrl, 'STAGE50_REQUIRE_LIVE=1 requires DATABASE_URL');
  const sha = exactSha();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vbot-stage50-'));
  setRuntimeEnvironment(tempRoot);

  // Production modules are loaded only after the isolated runtime environment is installed.
  const { startDashboard } = require('../src/dashboard/server') as typeof import('../src/dashboard/server');
  const prisma = (require('../src/database/prisma') as typeof import('../src/database/prisma')).default;
  const observerPool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
    application_name: 'vbot-stage50-observer',
  });
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  let runtime: Awaited<ReturnType<typeof startDashboard>> | undefined;
  let resourceTimer: NodeJS.Timeout | undefined;
  let stopDatabaseSampler = false;
  let databaseSampler: Promise<void> | undefined;
  let dashboardStopped = false;
  let observerPoolEnded = false;
  let prismaDisconnected = false;
  let tempRemoved = false;

  try {
    const versionResult = await observerPool.query<{ version: string }>('SELECT current_setting(\'server_version\') AS version');
    const databaseBefore = await databaseSnapshot(observerPool);
    runtime = await startDashboard(undefined, { port: 0, host: '127.0.0.1' });
    const address = runtime.address();
    assertContract(address && typeof address === 'object', 'dashboard must expose an ephemeral TCP address');
    assertContract(address.address === '127.0.0.1', 'dashboard load probe must bind only to 127.0.0.1');
    const origin = `http://127.0.0.1:${address.port}`;

    const preflight = await Promise.all([
      executeRequest(origin, 'liveness'),
      executeRequest(origin, 'readiness'),
      executeRequest(origin, 'authDenied'),
    ]);
    assertContract(preflight.every(sample => sample.ok), 'liveness, readiness and auth preflight contracts');

    const processBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    let peakRss = processBefore.rss;
    let peakHeapUsed = processBefore.heapUsed;
    let peakExternal = processBefore.external;
    let peakArrayBuffers = processBefore.arrayBuffers;
    let peakInFlight = 0;
    let inFlight = 0;
    const databaseProbeLatencies: number[] = [];
    const databaseProbeErrors: string[] = [];
    let peakObserverTotal = observerPool.totalCount;
    let peakObserverIdle = observerPool.idleCount;
    let peakObserverWaiting = observerPool.waitingCount;
    let peakDatabaseConnections = databaseBefore.connections;

    resourceTimer = setInterval(() => {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      peakHeapUsed = Math.max(peakHeapUsed, memory.heapUsed);
      peakExternal = Math.max(peakExternal, memory.external);
      peakArrayBuffers = Math.max(peakArrayBuffers, memory.arrayBuffers);
    }, 10);

    databaseSampler = (async () => {
      let sampleIndex = 0;
      while (!stopDatabaseSampler) {
        const started = performance.now();
        try {
          const result = await observerPool.query<{ ok: number }>('SELECT 1 AS ok');
          if (result.rows[0]?.ok !== 1) throw new Error('invalid SELECT 1 result');
          databaseProbeLatencies.push(performance.now() - started);
          if (sampleIndex % 5 === 0) {
            const connections = await observerPool.query<{ count: number }>(
              'SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()',
            );
            peakDatabaseConnections = Math.max(peakDatabaseConnections, Number(connections.rows[0]?.count ?? 0));
          }
        } catch (error) {
          databaseProbeErrors.push(error instanceof Error ? error.name : 'UnknownError');
        }
        peakObserverTotal = Math.max(peakObserverTotal, observerPool.totalCount);
        peakObserverIdle = Math.max(peakObserverIdle, observerPool.idleCount);
        peakObserverWaiting = Math.max(peakObserverWaiting, observerPool.waitingCount);
        sampleIndex += 1;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    })();

    eventLoop.enable();
    const samples: RequestSample[] = [];
    const loadStarted = performance.now();
    const deadline = loadStarted + durationMs;
    await Promise.all(Array.from({ length: concurrency }, async (_, workerId) => {
      let iteration = 0;
      while (performance.now() < deadline) {
        const route = routeFor(workerId, iteration);
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        try {
          samples.push(await executeRequest(origin, route));
        } finally {
          inFlight -= 1;
        }
        iteration += 1;
      }
    }));
    const elapsedMs = performance.now() - loadStarted;
    eventLoop.disable();
    stopDatabaseSampler = true;
    await databaseSampler;
    databaseSampler = undefined;
    if (resourceTimer) clearInterval(resourceTimer);
    resourceTimer = undefined;

    const processAfter = process.memoryUsage();
    const cpu = process.cpuUsage(cpuBefore);
    const databaseAfter = await databaseSnapshot(observerPool);
    const statusCodes: Record<string, number> = {};
    for (const sample of samples) statusCodes[String(sample.status)] = (statusCodes[String(sample.status)] ?? 0) + 1;
    const failed = samples.filter(sample => !sample.ok);
    const routeCounts = Object.fromEntries((['liveness', 'readiness', 'authDenied'] as const).map(route => [
      route,
      {
        requests: samples.filter(sample => sample.route === route).length,
        passed: samples.filter(sample => sample.route === route && sample.ok).length,
        latency: distribution(valuesForRoute(samples, route)),
      },
    ]));
    const allLatencies = samples.map(sample => sample.latencyMs);
    const elapsedSec = elapsedMs / 1_000;
    const totalCpuMs = (cpu.user + cpu.system) / 1_000;
    const errorRate = samples.length > 0 ? failed.length / samples.length : 1;
    const eventLoopDelay = {
      p50Ms: round(eventLoop.percentile(50) / 1_000_000),
      p95Ms: round(eventLoop.percentile(95) / 1_000_000),
      p99Ms: round(eventLoop.percentile(99) / 1_000_000),
      maxMs: round(eventLoop.max / 1_000_000),
      meanMs: round(eventLoop.mean / 1_000_000),
    };
    const requestLatency = distribution(allLatencies);
    const databaseProbeLatency = distribution(databaseProbeLatencies);
    const readiness = routeCounts.readiness;
    const authDenied = routeCounts.authDenied;
    const minimumRequests = concurrency * 5;
    const gates = {
      minimumRequests: samples.length >= minimumRequests,
      minimumRps: samples.length / elapsedSec >= 10,
      errorRate: errorRate <= 0.01,
      httpP99: requestLatency.p99Ms <= httpP99LimitMs,
      observedConcurrency: peakInFlight >= Math.min(concurrency, 8),
      databaseReadiness: readiness.requests > 0 && readiness.passed === readiness.requests,
      authFailClosed: authDenied.requests > 0 && authDenied.passed === authDenied.requests,
      databaseProbeSamples: databaseProbeLatencies.length >= 10,
      databaseProbeErrors: databaseProbeErrors.length === 0,
      databaseProbeP99: databaseProbeLatency.p99Ms <= dbP99LimitMs,
      eventLoopP99: Number.isFinite(eventLoopDelay.p99Ms) && eventLoopDelay.p99Ms <= eventLoopP99LimitMs,
      resourceMeasurements: [peakRss, peakHeapUsed, peakExternal, peakArrayBuffers, totalCpuMs].every(Number.isFinite),
    };
    const passed = Object.values(gates).every(Boolean);

    await runtime.stop();
    dashboardStopped = true;
    runtime = undefined;
    await prisma.$disconnect();
    prismaDisconnected = true;
    await observerPool.end();
    observerPoolEnded = true;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRemoved = true;

    const artifact = {
      schemaVersion: 1,
      stage: 50,
      exactSha: sha,
      capturedAt: new Date().toISOString(),
      environment: {
        transport: 'production dashboard over real TCP loopback',
        bindHost: '127.0.0.1',
        ephemeralPort: true,
        externalNetworkUsed: false,
        database: 'live PostgreSQL via redacted DATABASE_URL',
        postgresVersion: versionResult.rows[0]?.version ?? 'unknown',
        node: process.version,
        platform: process.platform,
        cpuCount: os.cpus().length,
      },
      config: { durationMs, concurrency, requestTimeoutMs },
      thresholds: {
        minimumRequests,
        minimumRps: 10,
        maximumErrorRate: 0.01,
        httpP99LimitMs,
        dbP99LimitMs,
        eventLoopP99LimitMs,
        minimumObservedConcurrency: Math.min(concurrency, 8),
        minimumDatabaseProbeSamples: 10,
      },
      http: {
        requests: samples.length,
        passed: samples.length - failed.length,
        errors: failed.length,
        errorRate: round(errorRate, 6),
        rps: round(samples.length / elapsedSec),
        elapsedMs: round(elapsedMs),
        peakInFlight,
        latency: requestLatency,
        statusCodes,
        routes: routeCounts,
        errorKinds: Object.fromEntries([...new Set(failed.map(sample => sample.error ?? `HTTP_${sample.status}`))].map(kind => [
          kind,
          failed.filter(sample => (sample.error ?? `HTTP_${sample.status}`) === kind).length,
        ])),
      },
      database: {
        readinessRequests: readiness.requests,
        readinessPassed: readiness.passed,
        observerProbe: {
          latency: databaseProbeLatency,
          errors: databaseProbeErrors,
          pool: {
            max: 4,
            peakTotal: peakObserverTotal,
            peakIdle: peakObserverIdle,
            peakWaiting: peakObserverWaiting,
          },
        },
        statisticsBefore: databaseBefore,
        statisticsAfter: databaseAfter,
        statisticsDelta: snapshotDelta(databaseAfter, databaseBefore),
        peakConnections: peakDatabaseConnections,
      },
      resources: {
        cpuUserMs: round(cpu.user / 1_000),
        cpuSystemMs: round(cpu.system / 1_000),
        cpuTotalMs: round(totalCpuMs),
        cpuUtilizationPercent: round((totalCpuMs / elapsedMs) * 100),
        rssMb: {
          start: round(processBefore.rss / 1024 / 1024),
          end: round(processAfter.rss / 1024 / 1024),
          peak: round(peakRss / 1024 / 1024),
        },
        heapUsedMb: {
          start: round(processBefore.heapUsed / 1024 / 1024),
          end: round(processAfter.heapUsed / 1024 / 1024),
          peak: round(peakHeapUsed / 1024 / 1024),
        },
        externalPeakMb: round(peakExternal / 1024 / 1024),
        arrayBuffersPeakMb: round(peakArrayBuffers / 1024 / 1024),
        eventLoopDelayMs: eventLoopDelay,
      },
      cleanup: { dashboardStopped, prismaDisconnected, observerPoolEnded, tempRemoved },
      gates,
      scopeBoundaries: {
        stage51: 'Long-duration multi-sample soak is measured separately in Stage 51.',
        stage67: 'Live Discord gateway and credentialed external-provider traffic require the owner-controlled production boundary.',
      },
      residual: [],
      passed,
    };

    const outputPath = path.resolve(root, process.env.STAGE50_OUTPUT_PATH ?? `stage50-artifacts/${sha}.json`);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify({ stage: 50, passed, exactSha: sha, outputPath })}\n`);
    assertContract(passed, `load gates failed: ${JSON.stringify(gates)}`);
  } finally {
    stopDatabaseSampler = true;
    if (databaseSampler) await databaseSampler.catch(() => undefined);
    if (resourceTimer) clearInterval(resourceTimer);
    eventLoop.disable();
    if (runtime) await runtime.stop().catch(() => undefined);
    if (!prismaDisconnected) await prisma.$disconnect().catch(() => undefined);
    if (!observerPoolEnded) await observerPool.end().catch(() => undefined);
    if (!tempRemoved) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().catch(error => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exitCode = 1;
});
