import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { recordPrismaLatency } from '../dashboard/services/observability';

/**
 * Prisma-Client mit getunten Connection-Pool-Defaults.
 *
 * Tuning-Strategie:
 * - Pool-Limit fest auf 10 gesetzt.
 * - Pool-Timeout/Idle-Verhalten explizit am pg-Adapter konfiguriert.
 * - Unter Jest/Test darf ein ausschliesslich idle DB-Pool den Node-Prozess
 *   nicht kuenstlich am Leben halten (`allowExitOnIdle`). Production bleibt
 *   unveraendert und wird weiterhin ueber den geordneten Shutdown geschlossen.
 */
export function ensureConnectionPoolParams(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('connection_limit')) {
      url.searchParams.set('connection_limit', '10');
    }
    if (!url.searchParams.has('pool_timeout')) {
      url.searchParams.set('pool_timeout', '20');
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

const tunedUrl = ensureConnectionPoolParams(process.env.DATABASE_URL);
const isTestRuntime = process.env.NODE_ENV === 'test' || Boolean(process.env.JEST_WORKER_ID);

// Prisma 7: PrismaClient benoetigt einen Driver Adapter. PrismaPg akzeptiert
// die node-postgres PoolConfig; allowExitOnIdle ist bewusst NUR im Test aktiv.
const adapter = new PrismaPg({
  connectionString: tunedUrl ?? process.env.DATABASE_URL ?? '',
  max: 10,
  idleTimeoutMillis: 20_000,
  allowExitOnIdle: isTestRuntime,
});

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
}).$extends({
  query: {
    $allOperations: async ({ model, operation, args, query }) => {
      const start = process.hrtime.bigint();
      try {
        const res = await query(args);
        const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
        recordPrismaLatency(model, operation, ms, true);
        return res;
      } catch (err) {
        const ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
        recordPrismaLatency(model, operation, ms, false);
        throw err;
      }
    },
  },
}) as unknown as PrismaClient;

export default prisma;
