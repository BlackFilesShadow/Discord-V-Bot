import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Loescht alle GUILD-SPEZIFISCHEN Moderations- und Aktivitaetsdaten eines Users
 * fuer eine bestimmte Guild, wenn er diese verlaesst.
 *
 * NICHT geloescht (cross-guild bzw. Hersteller-Daten):
 *  - User-Stammdaten
 *  - Packages, Uploads, ManufacturerRequest, OneTimePassword
 *  - Sessions, Tickets, Feedback (cross-guild bzw. Owner-relevant)
 *
 * Geloescht (Guild-Scope):
 *  - LevelData (userId, guildId)
 *  - XpRecord (userId, guildId)
 *  - ModerationCase (guildId, target=userId)  -> Appeals cascaden ueber FK
 *  - Reminder (userId, guildId)
 *
 * Atomar via prisma.$transaction. Bei Fehler: nichts geloescht, Logeintrag.
 *
 * @param guildId  Discord-Guild-ID
 * @param discordId Discord-User-ID des verlassenden Members
 * @returns Statistik-Objekt mit Anzahl geloeschter Records pro Tabelle
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

  // 1. User in DB aufloesen. Wenn unbekannt -> nichts zu tun.
  const dbUser = await prisma.user.findUnique({
    where: { discordId },
    select: { id: true },
  });
  if (!dbUser) {
    return { performed: false, reason: 'user_not_in_db', ...empty };
  }

  try {
    const [levelDel, xpDel, casesDel, remDel] = await prisma.$transaction([
      // LevelData ist per (userId, guildId) unique -> deleteMany ist sicher.
      prisma.levelData.deleteMany({
        where: { userId: dbUser.id, guildId },
      }),
      prisma.xpRecord.deleteMany({
        where: { userId: dbUser.id, guildId },
      }),
      // Nur Faelle, in denen der Verlassende das ZIEL war. Faelle, in denen er
      // selbst Moderator war, bleiben erhalten (Audit-Trail anderer User darf
      // nicht durch sein Leave verschwinden).
      prisma.moderationCase.deleteMany({
        where: { guildId, targetUserId: dbUser.id },
      }),
      prisma.reminder.deleteMany({
        where: { userId: discordId, guildId },
      }),
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
