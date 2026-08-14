import prisma from '../database/prisma';
import { config } from '../config';
import { isGlobalDeveloperIdentity } from '../security/privilegedIdentity';

/**
 * DB-gestützter Speicher für Dev-Auth-Session und Brute-Force-Lockout.
 *
 * Wichtig: DEV_PASSWORD ist nur Step-up. Eine Session darf ausschliesslich fuer
 * die kanonische GlobalDeveloperIdentity existieren; Besitz des Shared Passwords
 * kann niemals Developer-Rechte erzeugen.
 */
const SESSION_PREFIX = 'dev:auth:session:';
const FAILS_PREFIX = 'dev:auth:fails:';

export interface DevFailState {
  count: number;
  lockedUntil: number;
}

async function isEligible(discordId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { discordId },
    select: { role: true },
  });
  return isGlobalDeveloperIdentity(discordId, user?.role ?? 'USER', config.discord.ownerId);
}

export async function getDevSessionExpires(userId: string): Promise<number | null> {
  if (!(await isEligible(userId))) {
    await prisma.botConfig.deleteMany({ where: { key: SESSION_PREFIX + userId } });
    return null;
  }
  const row = await prisma.botConfig.findUnique({ where: { key: SESSION_PREFIX + userId } });
  if (!row) return null;
  const v = row.value as { expires?: number } | null;
  return typeof v?.expires === 'number' ? v.expires : null;
}

export async function setDevSession(userId: string, expires: number): Promise<void> {
  if (!(await isEligible(userId))) {
    throw new Error('DEV-Session verweigert: keine GlobalDeveloperIdentity.');
  }
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
      if (typeof v?.lockedUntil === 'number' && v.lockedUntil > 0 && v.lockedUntil < now) {
        toDelete.push(r.key);
      }
    }
  }
  if (toDelete.length) {
    await prisma.botConfig.deleteMany({ where: { key: { in: toDelete } } });
  }
}
