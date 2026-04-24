import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * XP-Manager (Sektion 8):
 * - Event-XP Vergabe (Teilnahme an Events, Giveaways, Polls)
 * - XP-Reset (für Events oder manuell)
 * - XP-Multiplikatoren
 */

/**
 * Event-XP vergeben (pro Guild getrennt).
 * Sektion 8: XP für Event-Teilnahme.
 */
export async function grantEventXp(
  userId: string,
  guildId: string,
  amount: number,
  eventType: string,
  eventId?: string,
): Promise<{ newXp: number; leveledUp: boolean; newLevel?: number }> {
  const updated = await prisma.levelData.upsert({
    where: { userId_guildId: { userId, guildId } },
    create: {
      userId,
      guildId,
      xp: BigInt(amount),
      totalMessages: 0,
      lastXpGain: new Date(),
    },
    update: {
      xp: { increment: BigInt(amount) },
      lastXpGain: new Date(),
    },
  });

  // XP-Record erstellen
  await prisma.xpRecord.create({
    data: {
      userId,
      guildId,
      amount,
      source: 'EVENT',
      description: `${eventType}${eventId ? ` (${eventId})` : ''}`,
    },
  });

  // Level-Up prüfen
  const currentXp = Number(updated.xp);
  const xpConfigCap = await prisma.xpConfig.findFirst({ where: { isActive: true } });
  const maxLevel = xpConfigCap?.maxLevel ?? 20;
  let newLevel = calculateLevel(currentXp);
  if (newLevel > maxLevel) newLevel = maxLevel;
  let leveledUp = false;

  if (newLevel > updated.level) {
    await prisma.levelData.update({
      where: { userId_guildId: { userId, guildId } },
      data: { level: newLevel },
    });
    leveledUp = true;

    logAudit('LEVEL_UP', 'LEVEL', {
      userId,
      guildId,
      newLevel,
      totalXp: currentXp,
      source: eventType,
    });
  }

  logAudit('EVENT_XP_GRANTED', 'LEVEL', {
    userId,
    guildId,
    amount,
    eventType,
    eventId,
  });

  return { newXp: currentXp, leveledUp, newLevel: leveledUp ? newLevel : undefined };
}

/**
 * XP eines Users in einer Guild zurücksetzen.
 * Sektion 8: XP-Reset.
 */
export async function resetUserXp(
  userId: string,
  guildId: string,
  resetBy: string,
  reason: string = 'Manual reset',
): Promise<boolean> {
  const levelData = await prisma.levelData.findUnique({
    where: { userId_guildId: { userId, guildId } },
  });
  if (!levelData) return false;

  const previousXp = Number(levelData.xp);
  const previousLevel = levelData.level;

  await prisma.levelData.update({
    where: { userId_guildId: { userId, guildId } },
    data: {
      xp: BigInt(0),
      level: 0,
      totalMessages: 0,
      voiceMinutes: 0,
      lastXpGain: null,
    },
  });

  await prisma.xpRecord.create({
    data: {
      userId,
      guildId,
      amount: -previousXp,
      source: 'RESET',
      description: reason,
    },
  });

  logAudit('XP_RESET', 'LEVEL', {
    userId,
    guildId,
    resetBy,
    reason,
    previousXp,
    previousLevel,
  });

  return true;
}

/**
 * Massen-XP-Reset für eine Guild (z.B. für Saison-Events).
 */
export async function resetAllXp(
  guildId: string,
  resetBy: string,
  reason: string = 'Season reset',
): Promise<number> {
  const result = await prisma.levelData.updateMany({
    where: { guildId },
    data: {
      xp: BigInt(0),
      level: 0,
      totalMessages: 0,
      voiceMinutes: 0,
      lastXpGain: null,
    },
  });

  logAudit('XP_MASS_RESET', 'LEVEL', {
    guildId,
    resetBy,
    reason,
    affectedUsers: result.count,
  });

  return result.count;
}

/**
 * XP-Multiplikator für bestimmte Zeiträume setzen.
 */
export async function setXpMultiplier(
  multiplier: number,
  durationMinutes: number,
  setBy: string,
): Promise<void> {
  const expiresAt = new Date(Date.now() + durationMinutes * 60 * 1000);

  await prisma.botConfig.upsert({
    where: { key: 'xp.multiplier' },
    create: {
      key: 'xp.multiplier',
      value: { multiplier, expiresAt: expiresAt.toISOString() },
      category: 'xp',
      description: `XP-Multiplikator: ${multiplier}x`,
      updatedBy: setBy,
    },
    update: {
      value: { multiplier, expiresAt: expiresAt.toISOString() },
      updatedBy: setBy,
    },
  });

  logAudit('XP_MULTIPLIER_SET', 'LEVEL', {
    multiplier,
    durationMinutes,
    expiresAt,
    setBy,
  });
}

/**
 * Aktuellen XP-Multiplikator abrufen.
 */
export async function getXpMultiplier(): Promise<number> {
  try {
    const cfg = await prisma.botConfig.findUnique({ where: { key: 'xp.multiplier' } });
    if (!cfg) return 1.0;

    const value = cfg.value as { multiplier?: number; expiresAt?: string };
    if (value.expiresAt && new Date(value.expiresAt) < new Date()) {
      return 1.0; // Abgelaufen
    }

    return value.multiplier || 1.0;
  } catch {
    return 1.0;
  }
}

function calculateLevel(xp: number): number {
  let level = 0;
  while (xpForLevel(level + 1) <= xp) {
    level++;
  }
  return level;
}

function xpForLevel(level: number): number {
  return 100 * (level * level) + 50 * level;
}

// Re-Export fuer Konsumenten ausserhalb (z.B. voiceStateUpdate.ts), damit
// alle XP-Quellen exakt dieselbe Level-Formel verwenden.
export { calculateLevel, xpForLevel };
