/**
 * Stage 47 — real PostgreSQL, Redis and persistent worker-queue baseline.
 *
 * The mandatory CI path sets STAGE47_REQUIRE_LIVE=1, DATABASE_URL and
 * REDIS_URL. Without that flag this command reports structural readiness but
 * never claims live verification.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createClient } from 'redis';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const requiredLive = process.env.STAGE47_REQUIRE_LIVE === '1';
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const sampleCount = boundedInteger(process.env.STAGE47_SAMPLE_COUNT, 20, 10, 100);
const poolConcurrency = boundedInteger(process.env.STAGE47_POOL_CONCURRENCY, 12, 8, 32);
const poolMax = 4;
const latencyLimitMs = boundedInteger(process.env.STAGE47_LATENCY_LIMIT_MS, 2_000, 250, 5_000);

function boundedInteger(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[index]);
}

function distribution(values) {
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

function exactSha() {
  if (process.env.STAGE47_EXACT_SHA) return process.env.STAGE47_EXACT_SHA;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

function structuralContracts() {
  const prismaSource = read('src/database/prisma.ts');
  const workerSource = read('src/modules/nitrado/jobWorker.ts');
  const leaseSource = read('src/modules/nitrado/jobLease.ts');
  const metricsSource = read('src/utils/metrics.ts');
  const schema = read('prisma/schema.prisma');
  return {
    prismaPoolMax10: /max:\s*10/.test(prismaSource),
    transactionMaxWait5s: /maxWait:\s*5_000/.test(prismaSource),
    transactionTimeout15s: /timeout:\s*15_000/.test(prismaSource),
    workerParallelBound4: /MAX_PARALLEL\s*=\s*4/.test(workerSource),
    workerCandidateBound: /take:\s*MAX_PARALLEL\s*\*\s*4/.test(workerSource),
    durableClaimLease: /claimNitradoJob/.test(workerSource) && /claimToken/.test(leaseSource),
    retryAndDeadLetter: /status:\s*'PENDING'/.test(workerSource) && /status:\s*'DEAD'/.test(workerSource),
    queueModelAndIndex: /model NitradoJob/.test(schema) && /@@index\(\[status, nextRunAt\]\)/.test(schema),
    queueDepthMetric: /vbot_nitrado_job_queue_depth/.test(metricsSource),
    oldestPendingMetric: /vbot_nitrado_job_oldest_pending_age_seconds/.test(metricsSource),
    inFlightMetric: /vbot_nitrado_job_worker_in_flight/.test(metricsSource),
    workerMetricRefresh: /refreshNitradoJobQueueMetrics/.test(workerSource),
  };
}

async function measurePostgres() {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: poolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  });
  const selectLatencies = [];
  const waitLatencies = [];
  const serviceLatencies = [];
  let peakWaiting = 0;
  let peakTotal = 0;
  let peakIdle = 0;
  let sampleTimer;
  try {
    const version = await pool.query('SELECT current_setting(\'server_version\') AS version');
    for (let i = 0; i < sampleCount; i += 1) {
      const started = performance.now();
      const result = await pool.query('SELECT 1 AS ok');
      if (result.rows[0]?.ok !== 1) throw new Error('PostgreSQL SELECT 1 returned an invalid result');
      selectLatencies.push(performance.now() - started);
    }

    sampleTimer = setInterval(() => {
      peakWaiting = Math.max(peakWaiting, pool.waitingCount);
      peakTotal = Math.max(peakTotal, pool.totalCount);
      peakIdle = Math.max(peakIdle, pool.idleCount);
    }, 2);
    sampleTimer.unref?.();
    await Promise.all(Array.from({ length: poolConcurrency }, async (_, index) => {
      const queuedAt = performance.now();
      const client = await pool.connect();
      const acquiredAt = performance.now();
      waitLatencies.push(acquiredAt - queuedAt);
      try {
        const serviceAt = performance.now();
        await client.query('SELECT pg_sleep(0.04), $1::int AS worker', [index]);
        serviceLatencies.push(performance.now() - serviceAt);
      } finally {
        client.release();
      }
    }));
    clearInterval(sampleTimer);
    sampleTimer = undefined;

    const queueClient = await pool.connect();
    const suffix = crypto.randomBytes(5).toString('hex');
    const guildId = `stage47-guild-${suffix}`;
    const connectionId = `stage47-conn-${suffix}`;
    const alias5 = suffix.slice(0, 5);
    try {
      await queueClient.query('BEGIN');
      await queueClient.query(
        `INSERT INTO "NitradoConnection"
          ("id", "guildId", "slot", "alias", "alias5", "encryptedToken", "addedByDiscordId", "updatedAt")
         VALUES ($1, $2, 1, 'Stage47', $3, 'stage47-non-secret', 'stage47-probe', NOW())`,
        [connectionId, guildId, alias5],
      );
      const statuses = ['PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'PENDING', 'RUNNING', 'RUNNING', 'DONE', 'FAILED', 'DEAD'];
      for (let index = 0; index < statuses.length; index += 1) {
        await queueClient.query(
          `INSERT INTO "NitradoJob"
            ("id", "guildId", "nitradoConnId", "operation", "payload", "status", "nextRunAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, 'KEEPALIVE', '{}'::jsonb, $4::"NitradoJobStatus",
                   NOW() - ($5::int * INTERVAL '1 second'),
                   NOW() - ($5::int * INTERVAL '1 second'), NOW())`,
          [`stage47-job-${suffix}-${index}`, guildId, connectionId, statuses[index], statuses.length - index],
        );
      }
      const depthStarted = performance.now();
      const depthResult = await queueClient.query(
        `SELECT "status"::text AS status, COUNT(*)::int AS count
           FROM "NitradoJob" WHERE "guildId" = $1 GROUP BY "status"`,
        [guildId],
      );
      const depthLatencyMs = performance.now() - depthStarted;
      const depths = Object.fromEntries(depthResult.rows.map(row => [row.status, row.count]));

      const claimStarted = performance.now();
      const claimResult = await queueClient.query(
        `SELECT "id" FROM "NitradoJob"
          WHERE "guildId" = $1 AND "status" = 'PENDING' AND "nextRunAt" <= NOW()
          ORDER BY "nextRunAt" ASC LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [guildId, poolMax],
      );
      const claimLatencyMs = performance.now() - claimStarted;
      const indexResult = await queueClient.query(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'NitradoJob'`,
      );
      const oldestResult = await queueClient.query(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MIN("createdAt")))::float8 AS age
           FROM "NitradoJob" WHERE "guildId" = $1 AND "status" = 'PENDING'`,
        [guildId],
      );
      await queueClient.query('ROLLBACK');
      return {
        serverVersion: version.rows[0]?.version,
        selectOne: distribution(selectLatencies),
        saturation: {
          poolMax,
          concurrency: poolConcurrency,
          peakTotal,
          peakIdle,
          peakWaiting,
          wait: distribution(waitLatencies),
          service: distribution(serviceLatencies),
          errors: 0,
        },
        workerQueue: {
          seededDepths: depths,
          depthLatencyMs: round(depthLatencyMs),
          oldestPendingAgeSeconds: round(Number(oldestResult.rows[0]?.age ?? 0)),
          claimLimit: poolMax,
          claimed: claimResult.rowCount,
          claimLatencyMs: round(claimLatencyMs),
          statusNextRunIndexPresent: indexResult.rows.some(row => /\("status",\s*"nextRunAt"\)/.test(row.indexdef)),
        },
      };
    } catch (error) {
      await queueClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      queueClient.release();
    }
  } finally {
    if (sampleTimer) clearInterval(sampleTimer);
    await pool.end();
  }
}

async function measureRedis() {
  const client = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: false,
    },
  });
  const errors = [];
  client.on('error', error => errors.push(error.message));
  const pingLatencies = [];
  const roundTripLatencies = [];
  const suffix = crypto.randomBytes(6).toString('hex');
  const key = `vbot:stage47:${suffix}`;
  try {
    await client.connect();
    for (let i = 0; i < sampleCount; i += 1) {
      const started = performance.now();
      const pong = await client.ping();
      if (pong !== 'PONG') throw new Error(`Redis PING returned ${String(pong)}`);
      pingLatencies.push(performance.now() - started);
    }
    for (let i = 0; i < sampleCount; i += 1) {
      const started = performance.now();
      await client.set(key, `value-${i}`, { EX: 30 });
      const value = await client.get(key);
      if (value !== `value-${i}`) throw new Error('Redis SET/GET round-trip mismatch');
      roundTripLatencies.push(performance.now() - started);
    }
    const burstKey = `${key}:burst`;
    const burstStarted = performance.now();
    const burstValues = await Promise.all(Array.from({ length: 32 }, () => client.incr(burstKey)));
    const burstLatencyMs = performance.now() - burstStarted;
    const ttlKey = `${key}:ttl`;
    await client.set(ttlKey, 'bounded', { EX: 30 });
    const ttlMs = await client.pTTL(ttlKey);
    await client.del([key, burstKey, ttlKey]);
    return {
      serverVersion: await client.info('server').then(info => /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown'),
      ping: distribution(pingLatencies),
      setGetRoundTrip: distribution(roundTripLatencies),
      concurrentBurst: {
        operations: burstValues.length,
        finalValue: burstValues.at(-1),
        latencyMs: round(burstLatencyMs),
      },
      ttlMs,
      errors,
    };
  } finally {
    if (client.isOpen) await client.quit();
  }
}

const contracts = structuralContracts();
if (!Object.values(contracts).every(Boolean)) {
  throw new Error(`Stage 47 structural contracts failed: ${JSON.stringify(contracts)}`);
}
if (requiredLive && (!databaseUrl || !redisUrl)) {
  throw new Error('STAGE47_REQUIRE_LIVE=1 requires both DATABASE_URL and REDIS_URL');
}

const capturedAt = new Date().toISOString();
const result = {
  schemaVersion: 1,
  stage: 47,
  exactSha: exactSha(),
  capturedAt,
  requiredLive,
  contracts,
  postgres: databaseUrl ? await measurePostgres() : { attempted: false },
  redis: redisUrl ? await measureRedis() : { attempted: false },
  thresholds: {
    latencyLimitMs,
    requirePoolWaiting: true,
    requireQueueClaimBound: poolMax,
    requireRedisBurstFinalValue: 32,
  },
  residual: [],
};

if (!databaseUrl) result.residual.push('Live PostgreSQL measurement not attempted');
if (!redisUrl) result.residual.push('Live Redis measurement not attempted');
if (databaseUrl) {
  if (result.postgres.selectOne.p99Ms > latencyLimitMs) throw new Error('PostgreSQL SELECT 1 p99 exceeded bound');
  if (result.postgres.saturation.peakWaiting < 1) throw new Error('PostgreSQL pool saturation did not observe waiting work');
  if (result.postgres.saturation.peakTotal !== poolMax) throw new Error('PostgreSQL pool did not respect the configured max');
  if (result.postgres.workerQueue.claimed !== poolMax) throw new Error('Worker queue claim did not respect MAX_PARALLEL');
  if (!result.postgres.workerQueue.statusNextRunIndexPresent) throw new Error('Worker queue status/nextRunAt index missing');
  if (JSON.stringify(result.postgres.workerQueue.seededDepths) === '{}') throw new Error('Worker queue depths were not measured');
}
if (redisUrl) {
  if (result.redis.ping.p99Ms > latencyLimitMs) throw new Error('Redis PING p99 exceeded bound');
  if (result.redis.setGetRoundTrip.p99Ms > latencyLimitMs) throw new Error('Redis SET/GET p99 exceeded bound');
  if (result.redis.concurrentBurst.finalValue !== 32) throw new Error('Redis concurrent burst lost writes');
  if (result.redis.ttlMs <= 0 || result.redis.ttlMs > 30_000) throw new Error('Redis TTL contract failed');
  if (result.redis.errors.length > 0) throw new Error(`Redis emitted errors: ${result.redis.errors.join('; ')}`);
}
if (requiredLive && result.residual.length > 0) {
  throw new Error(`Mandatory live Stage 47 residuals remain: ${result.residual.join('; ')}`);
}

const outputPath = process.env.STAGE47_OUTPUT_PATH
  ?? path.join(root, 'stage47-artifacts', `${result.exactSha}.json`);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
