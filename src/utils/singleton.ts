import prisma from '../database/prisma';
import { logger } from '../utils/logger';
import os from 'os';
import crypto from 'crypto';

/**
 * Singleton-Lock: Verhindert dass zwei Bot-Instanzen mit demselben Token
 * gleichzeitig laufen (Doppelantworten).
 *
 * Strategie:
 * - Beim Start: Heartbeat-Lock schreiben (instanceId + timestamp).
 * - Wenn ein anderes Heartbeat juenger als 30s ist -> Konflikt -> exit.
 * - Heartbeat alle 10s aktualisieren.
 */

/**
 * Shard-spezifischer Lock-Key. Unter dem discord.js-ShardingManager laeuft jeder
 * Shard als eigener Prozess (eigene index.ts) und setzt process.env.SHARDS auf seine
 * Shard-ID. Ein globaler Lock wuerde alle Shards bis auf einen per process.exit(2)
 * beenden. Per-Shard-Lock erlaubt Multi-Shard-Betrieb, verhindert aber weiterhin
 * zwei Prozesse fuer dieselbe Shard-ID (Doppelantworten).
 */
const shardId = process.env.SHARDS ?? 'solo';
const LOCK_KEY = `bot:singleton:lock:${shardId}`;
const HEARTBEAT_INTERVAL_MS = 10_000;
const STALE_THRESHOLD_MS = 30_000;

/**
 * Stabiler Host-Identifier. In Docker vergibt jeder Container-Restart einen
 * neuen Hostnamen (Container-ID), wodurch die "Same-Host"-Erkennung versagt.
 * BOT_STABLE_HOST_ID (z. B. via docker-compose.yml gesetzt) erlaubt es, den
 * Host als stabil zu markieren, sodass nach einem Crash der neue Container
 * den Lock automatisch uebernimmt.
 */
const stableHostId = process.env.BOT_STABLE_HOST_ID || os.hostname();
const FORCE_TAKEOVER = process.env.FORCE_SINGLETON_TAKEOVER === '1';

const instanceId = `${stableHostId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

interface LockValue {
  instanceId: string;
  hostname: string;
  pid: number;
  ts: number;
}

export async function acquireSingletonLock(): Promise<void> {
  const now = Date.now();

  const existing = await prisma.botConfig.findUnique({ where: { key: LOCK_KEY } });

  if (existing) {
    const v = existing.value as unknown as LockValue;
    const age = now - (v?.ts ?? 0);
    if (v?.instanceId && v.instanceId !== instanceId && age < STALE_THRESHOLD_MS) {
      // Force-Takeover via ENV (Notfall-Override fuer Deployments).
      if (FORCE_TAKEOVER) {
        logger.warn(
          `FORCE_SINGLETON_TAKEOVER aktiv. Uebernehme Lock von ${v.instanceId} (ageMs=${age}).`,
        );
      }
      // Gleicher (stabiler) Host = alte Container-Instanz wurde gekillt
      // ohne Release. Wir wissen, sie ist tot. -> Force-Takeover.
      else if (v.hostname === stableHostId || v.hostname === os.hostname()) {
        logger.warn(
          `Singleton-Lock von alter Instanz auf demselben Host gefunden ` +
          `(${v.instanceId}, ageMs=${age}). Uebernehme Lock.`,
        );
      } else {
        logger.error(
          `SINGLETON-KONFLIKT: Andere Bot-Instanz aktiv ` +
          `(instance=${v.instanceId} host=${v.hostname} pid=${v.pid} ageMs=${age}). ` +
          `Beende, um Doppelantworten zu vermeiden. Stoppe die andere Instanz, dann neu starten. ` +
          `Notfall-Override: FORCE_SINGLETON_TAKEOVER=1 setzen.`,
        );
        process.exit(2);
      }
    }
  }

  // Lock uebernehmen
  await prisma.botConfig.upsert({
    where: { key: LOCK_KEY },
    create: {
      key: LOCK_KEY,
      value: { instanceId, hostname: stableHostId, pid: process.pid, ts: now } as object,
      category: 'system',
      description: 'Singleton-Lock fuer aktive Bot-Instanz (Doppelantwort-Schutz)',
    },
    update: {
      value: { instanceId, hostname: stableHostId, pid: process.pid, ts: now } as object,
    },
  });

  logger.info(`Singleton-Lock erworben: instance=${instanceId}`);

  // Lock bei Shutdown freigeben (verhindert Restart-Loop)
  const release = async () => {
    try {
      await prisma.botConfig.deleteMany({
        where: { key: LOCK_KEY, value: { path: ['instanceId'], equals: instanceId } },
      });
      logger.info('Singleton-Lock freigegeben.');
    } catch { /* shutdown best-effort */ }
  };
  process.once('SIGTERM', release);
  process.once('SIGINT', release);
  process.once('beforeExit', release);

  // Heartbeat
  setInterval(async () => {
    try {
      // Vor Heartbeat pruefen, ob jemand den Lock uebernommen hat
      const cur = await prisma.botConfig.findUnique({ where: { key: LOCK_KEY } });
      const v = cur?.value as unknown as LockValue | undefined;
      if (v?.instanceId && v.instanceId !== instanceId) {
        logger.error(
          `SINGLETON-LOCK uebernommen von anderer Instanz (${v.instanceId}). Beende.`,
        );
        process.exit(2);
      }
      await prisma.botConfig.update({
        where: { key: LOCK_KEY },
        data: {
          value: { instanceId, hostname: stableHostId, pid: process.pid, ts: Date.now() } as object,
        },
      });
    } catch (e) {
      logger.warn(`Singleton-Heartbeat fehlgeschlagen: ${(e as Error).message}`);
    }
  }, HEARTBEAT_INTERVAL_MS).unref?.();
}
