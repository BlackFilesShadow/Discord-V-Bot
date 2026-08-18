import crypto from 'crypto';
import { Client as PgClient } from 'pg';
import { logger } from '../../utils/logger';

// MUSS exakt dem Namespace des NitradoJob-Workers entsprechen. Ein Runtime-
// Architekturtest vergleicht beide Key-Ableitungen, damit Worker und Owner-
// Konfigurationsmutationen niemals unbemerkt auseinanderlaufen.
const CONN_LOCK_NAMESPACE = 0x4e495452;

export interface HeldNitradoConfigLock {
  release: () => Promise<void>;
}

export function nitradoConfigMutationLockKeys(nitradoConnId: string): [number, number] {
  const digest = crypto.createHash('sha256').update(nitradoConnId).digest();
  return [CONN_LOCK_NAMESPACE, digest.readInt32BE(0)];
}

/**
 * Nicht-blockierender Session-Advisory-Lock fuer Owner-Konfigurationsmutationen.
 *
 * Der NitradoJob-Worker verwendet denselben PostgreSQL-Key pro Connection. Damit
 * koennen Token, Service-ID und Slot-Loeschung niemals waehrend eines laufenden
 * Remote-Jobs committed werden. `null` bedeutet: Connection ist gerade busy.
 */
export async function tryAcquireNitradoConfigMutationLock(
  nitradoConnId: string,
): Promise<HeldNitradoConfigLock | null> {
  const [k1, k2] = nitradoConfigMutationLockKeys(nitradoConnId);
  const client = new PgClient({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1, $2) AS locked', [k1, k2]);
    if (result.rows?.[0]?.locked !== true) {
      await client.end();
      return null;
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [k1, k2]);
      } catch (error) {
        logger.warn(`Nitrado-Konfigurationslock konnte nicht sauber freigegeben werden: ${String(error)}`);
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
}
