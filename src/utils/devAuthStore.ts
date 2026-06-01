import prisma from '../database/prisma';

/**
 * DB-gestützter Speicher für Dev-Auth-Session und Brute-Force-Lockout.
 *
 * Hintergrund (Multi-Server / Sharding, Entscheidung #8): Unter dem
 * ShardingManager läuft jeder Shard als eigener Prozess. Würde der
 * Fehlversuch-Zähler nur im Prozess-Speicher liegen, könnte ein Angreifer den
 * Lockout über mehrere Shards hinweg umgehen (MAX_FAILS Versuche je Shard) und
 * der Lockout überlebte keinen Restart. Daher global in BotConfig persistiert.
 *
 * Geringe Kardinalität (nur Owner/Developer), daher BotConfig-Key/Value
 * ausreichend — kein eigenes Modell nötig.
 */

const SESSION_PREFIX = 'dev:auth:session:';
const FAILS_PREFIX = 'dev:auth:fails:';

export interface DevFailState {
  count: number;
  lockedUntil: number;
}

export async function getDevSessionExpires(userId: string): Promise<number | null> {
  const row = await prisma.botConfig.findUnique({ where: { key: SESSION_PREFIX + userId } });
  if (!row) return null;
  const v = row.value as { expires?: number } | null;
  return typeof v?.expires === 'number' ? v.expires : null;
}

export async function setDevSession(userId: string, expires: number): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: SESSION_PREFIX + userId },
    create: {
      key: SESSION_PREFIX + userId,
      value: { expires } as object,
      category: 'security',
      description: 'Dev-Session (Multi-Shard global)',
    },
    update: { value: { expires } as object },
  });
}

export async function clearDevSession(userId: string): Promise<void> {
  await prisma.botConfig.deleteMany({ where: { key: SESSION_PREFIX + userId } });
}

export async function getDevFails(userId: string): Promise<DevFailState | null> {
  const row = await prisma.botConfig.findUnique({ where: { key: FAILS_PREFIX + userId } });
  if (!row) return null;
  const v = row.value as Partial<DevFailState> | null;
  if (typeof v?.count !== 'number' || typeof v?.lockedUntil !== 'number') return null;
  return { count: v.count, lockedUntil: v.lockedUntil };
}

export async function setDevFails(userId: string, state: DevFailState): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: FAILS_PREFIX + userId },
    create: {
      key: FAILS_PREFIX + userId,
      value: state as object,
      category: 'security',
      description: 'Dev-Auth Brute-Force-Lockout (Multi-Shard global)',
    },
    update: { value: state as object },
  });
}

export async function clearDevFails(userId: string): Promise<void> {
  await prisma.botConfig.deleteMany({ where: { key: FAILS_PREFIX + userId } });
}

/**
 * Entfernt abgelaufene Sessions und abgelaufene Lockouts. Best-effort,
 * periodisch aufgerufen. Niedrige Kardinalität -> in-JS-Filter ist günstig.
 */
export async function cleanupDevAuth(): Promise<void> {
  const now = Date.now();
  const rows = await prisma.botConfig.findMany({
    where: { OR: [{ key: { startsWith: SESSION_PREFIX } }, { key: { startsWith: FAILS_PREFIX } }] },
  });
  const toDelete: string[] = [];
  for (const r of rows) {
    if (r.key.startsWith(SESSION_PREFIX)) {
      const v = r.value as { expires?: number } | null;
      if (typeof v?.expires !== 'number' || v.expires < now) toDelete.push(r.key);
    } else {
      const v = r.value as Partial<DevFailState> | null;
      // Abgelaufene Lockouts entfernen (lockedUntil gesetzt und in Vergangenheit).
      if (typeof v?.lockedUntil === 'number' && v.lockedUntil > 0 && v.lockedUntil < now) {
        toDelete.push(r.key);
      }
    }
  }
  if (toDelete.length) {
    await prisma.botConfig.deleteMany({ where: { key: { in: toDelete } } });
  }
}
