import { Client } from 'pg';
import { logger } from '../utils/logger';
import os from 'os';
import crypto from 'crypto';

/**
 * Singleton-Lock (F-008): Verhindert dass zwei Bot-Instanzen mit demselben
 * Token gleichzeitig laufen (Doppelantworten).
 *
 * Strategie: PostgreSQL **Advisory Lock** auf einer dedizierten Verbindung.
 *  - `pg_try_advisory_lock` ist atomar -> kein TOCTOU-Race wie beim frueheren
 *    findUnique+upsert-Ansatz.
 *  - Der Lock ist an die Session (Verbindung) gebunden. Stirbt die Instanz,
 *    schliesst Postgres die Verbindung und gibt den Lock automatisch frei ->
 *    keine Stale-Heuristik/Heartbeat noetig.
 *  - Verliert die dedizierte Verbindung ihren Lock, beendet sich die Instanz
 *    fail-safe.
 *
 * Per-Shard: Unter dem ShardingManager setzt jeder Shard process.env.SHARDS auf
 * seine ID -> eigener Lock-Key, damit Multi-Shard-Betrieb moeglich bleibt.
 */

const shardId = process.env.SHARDS ?? 'solo';
const LOCK_KEY = `bot:singleton:lock:${shardId}`;
const KEEPALIVE_INTERVAL_MS = 10_000;
// int4-Namespace ('VBOT') fuer alle Bot-Singleton-Advisory-Locks.
const LOCK_NAMESPACE = 0x56424f54;

const stableHostId = process.env.BOT_STABLE_HOST_ID || os.hostname();
const instanceId = `${stableHostId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** Deterministische (int4, int4)-Advisory-Lock-Keys aus dem Shard-Lock-Key. */
export function advisoryLockKeys(lockKey: string): [number, number] {
  const digest = crypto.createHash('sha256').update(lockKey).digest();
  return [LOCK_NAMESPACE, digest.readInt32BE(0)];
}

let keepalive: NodeJS.Timeout | null = null;

export async function acquireSingletonLock(
  createClient: () => Client = () => new Client({ connectionString: process.env.DATABASE_URL }),
): Promise<void> {
  const [k1, k2] = advisoryLockKeys(LOCK_KEY);
  const client = createClient();
  await client.connect();

  const res = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [k1, k2]);
  const locked = res.rows?.[0]?.locked === true;
  if (!locked) {
    logger.error(
      `SINGLETON-KONFLIKT: Advisory-Lock (${LOCK_KEY}) wird bereits von einer aktiven Instanz gehalten. ` +
      `Beende, um Doppelantworten zu vermeiden. Stoppe die andere Instanz, dann neu starten.`,
    );
    try { await client.end(); } catch { /* best-effort */ }
    process.exit(2);
    return; // erreichbar nur wenn process.exit gestubbt ist (Tests)
  }

  logger.info(`Singleton-Lock (advisory) erworben: instance=${instanceId}`);

  // Verlorene Verbindung = verlorener Lock -> fail-safe beenden.
  client.on('error', (e: Error) => {
    logger.error(`SINGLETON-LOCK-Verbindung verloren (${e.message}). Beende (fail-safe).`);
    process.exit(2);
  });

  keepalive = setInterval(() => {
    client.query('SELECT 1').catch((e: unknown) => {
      logger.error(`Singleton-Keepalive fehlgeschlagen (${(e as Error).message}). Beende.`);
      process.exit(2);
    });
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  const release = async () => {
    try {
      if (keepalive) { clearInterval(keepalive); keepalive = null; }
      await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      await client.end();
      logger.info('Singleton-Lock freigegeben.');
    } catch { /* shutdown best-effort */ }
  };
  process.once('SIGTERM', release);
  process.once('SIGINT', release);
  process.once('beforeExit', release);
}
