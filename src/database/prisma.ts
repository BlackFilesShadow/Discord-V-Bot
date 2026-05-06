import { PrismaClient } from '@prisma/client';

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

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'info', 'warn', 'error'] : ['error'],
  ...(tunedUrl ? { datasources: { db: { url: tunedUrl } } } : {}),
});

export default prisma;
