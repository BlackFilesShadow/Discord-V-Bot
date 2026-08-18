import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Loescht alle GUILD-SPEZIFISCHEN Moderations- und Aktivitaetsdaten eines Users
 * fuer eine bestimmte Guild, wenn der optionale Leave-Cleanup aktiv ist.
 *
 * NICHT geloescht (cross-guild bzw. Hersteller-Daten):
 *  - User-Stammdaten
 *  - Packages, Uploads, ManufacturerRequest, OneTimePassword
 *  - Sessions, Tickets, Feedback (cross-guild bzw. Owner-relevant)
 *
 * Geloescht (Guild-Scope):
 *  - LevelData (userId, guildId)
 *  - XpRecord (userId, guildId)
 *  - ModerationCase (guildId, target=userId) -> Appeals cascaden ueber FK
 *  - Reminder (Discord-userId, guildId), auch wenn kein User-Stammsatz existiert
 *
 * Atomar via prisma.$transaction. Bei Fehler: nichts geloescht, Logeintrag.
 */
export async function cleanupGuildMemberData(
  guildId: string,
  discordId: string,
): Promise<{
  performed: boolean;
  reason?: string;
  levelData: number;
  xpRecords: number;
  moderationCases: number;
  reminders: number;
}> {
  const empty = { levelData: 0, xpRecords: 0, moderationCases: 0, reminders: 0 };
  const dbUser = await prisma.user.findUnique({
    where: { discordId },
    select: { id: true },
  });

  try {
    // Reminder besitzt bewusst die rohe Discord-ID und keine User-FK. Deshalb
    // muss dieser Guild-Scope auch ohne aufloesbaren User-Stammsatz bereinigt
    // werden; sonst bliebe beim vollstaendigen Leave-Reset personenbezogene
    // Scheduler-History zurueck.
    if (!dbUser) {
      const remDel = await prisma.reminder.deleteMany({
        where: { userId: discordId, guildId },
      });
      logAudit('GUILD_MEMBER_DATA_CLEANUP', 'MODERATION', {
        guildId,
        discordId,
        userId: null,
        ...empty,
        reminders: remDel.count,
      });
      return { performed: true, ...empty, reminders: remDel.count };
    }

    const [levelDel, xpDel, casesDel, remDel] = await prisma.$transaction([
      prisma.levelData.deleteMany({ where: { userId: dbUser.id, guildId } }),
      prisma.xpRecord.deleteMany({ where: { userId: dbUser.id, guildId } }),
      // Nur Faelle, in denen der Verlassende das ZIEL war. Faelle, in denen er
      // selbst Moderator war, bleiben als Audit-Trail anderer User erhalten.
      prisma.moderationCase.deleteMany({ where: { guildId, targetUserId: dbUser.id } }),
      prisma.reminder.deleteMany({ where: { userId: discordId, guildId } }),
    ]);

    logAudit('GUILD_MEMBER_DATA_CLEANUP', 'MODERATION', {
      guildId,
      discordId,
      userId: dbUser.id,
      levelData: levelDel.count,
      xpRecords: xpDel.count,
      moderationCases: casesDel.count,
      reminders: remDel.count,
    });

    return {
      performed: true,
      levelData: levelDel.count,
      xpRecords: xpDel.count,
      moderationCases: casesDel.count,
      reminders: remDel.count,
    };
  } catch (e) {
    logger.error(
      `cleanupGuildMemberData fehlgeschlagen (guild=${guildId}, user=${discordId}): ${(e as Error).message}`,
    );
    return { performed: false, reason: 'transaction_failed', ...empty };
  }
}
