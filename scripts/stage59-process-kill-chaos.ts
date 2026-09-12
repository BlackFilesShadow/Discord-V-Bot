import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from 'redis';
import prisma from '../src/database/prisma';

type ProbeResult = {
  case: string;
  ok: boolean;
  elapsedMs: number;
  note: string;
};

const exactSha = process.env.STAGE59_EXACT_SHA || process.env.GITHUB_SHA || gitSha();
const outputPath = process.env.STAGE59_OUTPUT_PATH
  || path.join('stage59-artifacts', `${exactSha}.json`);
const requireDocker = process.env.STAGE59_REQUIRE_DOCKER === '1';

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function findSingleContainerByPort(port: number): string {
  const ids = docker(['ps', '--filter', `publish=${port}`, '--format', '{{.ID}}'])
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length !== 1) {
    throw new Error(`Stage59 expected exactly one running Docker service publishing ${port}, found ${ids.length}`);
  }
  return ids[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(label: string, probe: () => Promise<boolean>, timeoutMs = 30_000): Promise<number> {
  const started = Date.now();
  let lastError: unknown = null;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await probe()) return Date.now() - started;
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`${label} did not recover within ${timeoutMs}ms${detail}`);
}

async function requireBoundedFailure(
  label: string,
  operation: () => Promise<unknown>,
  timeoutMs = 8_000,
): Promise<{ elapsedMs: number; message: string }> {
  const started = Date.now();
  const outcome = await Promise.race([
    operation().then(
      () => ({ kind: 'success' as const, message: '' }),
      (error: unknown) => ({
        kind: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    ),
    sleep(timeoutMs).then(() => ({ kind: 'timeout' as const, message: '' })),
  ]);
  const elapsedMs = Date.now() - started;
  if (outcome.kind === 'success') {
    throw new Error(`${label} unexpectedly succeeded while its dependency container was stopped`);
  }
  if (outcome.kind === 'timeout') {
    throw new Error(`${label} did not fail closed within ${timeoutMs}ms`);
  }
  return { elapsedMs, message: outcome.message.slice(0, 240) };
}

async function postgresProbe(): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1::int AS ok');
  return rows[0]?.ok === 1;
}

async function main(): Promise<void> {
  if (!requireDocker) {
    throw new Error('Stage59 destructive service-chaos harness is CI-only; set STAGE59_REQUIRE_DOCKER=1 explicitly');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required');

  const results: ProbeResult[] = [];
  const postgresId = findSingleContainerByPort(5432);
  const redisId = findSingleContainerByPort(6379);
  let postgresStopped = false;
  let redisStopped = false;

  const redis = createClient({
    url: redisUrl,
    socket: {
      connectTimeout: 2_000,
      reconnectStrategy: false,
    },
  });
  // Expected transport errors during the intentional kill must not become an
  // uncaught EventEmitter error. They are asserted explicitly below.
  redis.on('error', () => undefined);

  try {
    const pgWarmStart = Date.now();
    if (!(await postgresProbe())) throw new Error('PostgreSQL warmup probe returned unexpected data');
    results.push({ case: 'postgres-warmup', ok: true, elapsedMs: Date.now() - pgWarmStart, note: 'Prisma query succeeded before fault injection' });

    await redis.connect();
    const redisWarmStart = Date.now();
    if ((await redis.ping()) !== 'PONG') throw new Error('Redis warmup ping did not return PONG');
    results.push({ case: 'redis-warmup', ok: true, elapsedMs: Date.now() - redisWarmStart, note: 'Redis client succeeded before fault injection' });

    docker(['stop', '--time', '1', postgresId]);
    postgresStopped = true;
    const pgFailure = await requireBoundedFailure('PostgreSQL/Prisma probe', () => postgresProbe());
    results.push({
      case: 'postgres-kill-fails-closed',
      ok: true,
      elapsedMs: pgFailure.elapsedMs,
      note: `Same Prisma runtime rejected while PostgreSQL was down: ${pgFailure.message}`,
    });

    docker(['start', postgresId]);
    postgresStopped = false;
    const pgRecoveryMs = await waitUntil('PostgreSQL same-client recovery', postgresProbe);
    results.push({
      case: 'postgres-same-client-recovery',
      ok: true,
      elapsedMs: pgRecoveryMs,
      note: 'The existing Prisma client recovered after the same container restarted',
    });

    docker(['stop', '--time', '1', redisId]);
    redisStopped = true;
    const redisFailure = await requireBoundedFailure('Redis ping', () => redis.ping(), 5_000);
    results.push({
      case: 'redis-kill-fails-closed',
      ok: true,
      elapsedMs: redisFailure.elapsedMs,
      note: `Redis client rejected while the service was down: ${redisFailure.message}`,
    });

    docker(['start', redisId]);
    redisStopped = false;
    const redisRecoveryMs = await waitUntil('Redis client recovery', async () => {
      try {
        if (!redis.isOpen) await redis.connect();
        return (await redis.ping()) === 'PONG';
      } catch {
        return false;
      }
    });
    results.push({
      case: 'redis-client-recovery',
      ok: true,
      elapsedMs: redisRecoveryMs,
      note: 'Redis became usable again after the same service container restarted',
    });
  } finally {
    if (postgresStopped) {
      try { docker(['start', postgresId]); } catch { /* best-effort restore before CI teardown */ }
    }
    if (redisStopped) {
      try { docker(['start', redisId]); } catch { /* best-effort restore before CI teardown */ }
    }
    try {
      if (redis.isOpen) await redis.quit();
    } catch {
      try { redis.disconnect(); } catch { /* no-op */ }
    }
    await prisma.$disconnect();
  }

  const envelope = {
    stage: 59,
    kind: 'docker-service-process-kill-chaos',
    exactSha,
    capturedAt: new Date().toISOString(),
    services: ['postgresql', 'redis'],
    results,
    residual: [],
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

main().catch(async (error) => {
  try { await prisma.$disconnect(); } catch { /* no-op */ }
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
