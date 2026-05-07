import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { recordPrismaLatency } from '../dashboard/services/observability';

/**
 * Prisma-Client mit getunten Connection-Pool-Defaults.
 *
 * Tuning-Strategie:
 * - Pool-Limit fest auf 10 gesetzt (Prisma-Default-Heuristik
 *   `num_physical_cpus * 2 + 1` ist auf shared Hostern zu hoch und
 *   kann das Postgres-`max_connections`-Limit reissen, wenn mehrere
 *   Bot-Shards laufen).
 * - Pool-Timeout 20s (Default 10s) — vermeidet "Timed out fetching a new
 *   connection"-Spikes bei kurzfristigen Lastspitzen.
 *
 * Werte werden NUR in DATABASE_URL gemerged, wenn dort noch nicht gesetzt —
 * Operator-Override (z.B. fuer kleine VMs) jederzeit moeglich.
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
    // URL nicht parsebar (z.B. unix socket path) -> unveraendert lassen
    return rawUrl;
  }
}

const tunedUrl = ensureConnectionPoolParams(process.env.DATABASE_URL);

// Prisma 7: Direkter Connection-Mode entfernt — PrismaClient benoetigt jetzt
// einen Driver Adapter (oder accelerateUrl). Wir nutzen `@prisma/adapter-pg`
// mit der getunten URL (Pool-Limit/Timeout via Query-Params von node-postgres
// werden ignoriert, daher steuert der Adapter selbst den Pool).
const adapter = new PrismaPg({
  connectionString: tunedUrl ?? process.env.DATABASE_URL ?? '',
  max: 10,
  // node-postgres pool: idle clients werden nach 20s geschlossen
  idleTimeoutMillis: 20_000,
});

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
}).$extends({
  // Prisma 7: $use Middleware-API wurde entfernt. Wir nutzen $extends mit
  // query.$allOperations fuer Latenz-Tracking (siehe observability.ts).
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
