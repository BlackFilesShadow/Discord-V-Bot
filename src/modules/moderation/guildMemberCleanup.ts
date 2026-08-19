import prisma from '../../database/prisma';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { postFactionEmbed, postFactionList } from '../factions/factionEmbed';
import { logger, logAudit } from '../../utils/logger';

/**
 * Loescht alle LIVE-GUILD-Zustaende eines Users fuer eine bestimmte Guild,
 * wenn der optionale Leave-Cleanup aktiv ist.
 *
 * NICHT geloescht (cross-guild bzw. Hersteller-/Audit-Daten):
 *  - User-Stammdaten
 *  - Packages, Uploads, ManufacturerRequest, OneTimePassword
 *  - Support-/Ticket-/Audit-Historie
 *  - Rollenbasierte GuildPermissionRoleGrant (gehoeren der Discord-Rolle,
 *    nicht dem austretenden User; Discord entfernt die Rolle beim Austritt)
 *  - historische Actor-Felder wie grantedByDiscordId/approvedByDiscordId
 *
 * Geloescht / neutralisiert (Guild-Scope):
 *  - LevelData + XpRecord
 *  - ModerationCase, wenn der User das Ziel war (Appeals cascaden ueber FK)
 *  - Reminder
 *  - direkter GuildPermissionGrant des Users
 *  - FactionMember-Zeilen des Users
 *  - Faction leader/deputy/treasurer-Verweise auf den User
 *
 * Die DB-Mutationen laufen atomar in EINER Transaktion. Discord-Faction-Embeds
 * werden danach best-effort aktualisiert und duerfen den Daten-Cleanup niemals
 * wieder zurueckrollen oder blockieren.
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
  permissionGrants: number;
  factionMemberships: number;
  factionLeadershipRefs: number;
}> {
  const empty = {
    levelData: 0,
    xpRecords: 0,
    moderationCases: 0,
    reminders: 0,
    permissionGrants: 0,
    factionMemberships: 0,
    factionLeadershipRefs: 0,
  };

  try {
    const result = await prisma.$transaction(async tx => {
      // Der User-Stammsatz ist fuer Level/XP/Moderation noetig. Direkte
      // Discord-ID-Zustaende (Reminder, Grants, Factions) muessen aber auch dann
      // geloescht werden, wenn kein User-Datensatz mehr aufloesbar ist.
      const dbUser = await tx.user.findUnique({
        where: { discordId },
        select: { id: true },
      });

      // Alle Faction-IDs werden innerhalb derselben Transaktion und strikt fuer
      // diese Guild gelesen. FactionMember besitzt selbst keine guildId-Spalte.
      const factions = await tx.faction.findMany({
        where: { guildId },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const factionIds = factions.map(faction => faction.id);

      const permissionDel = await tx.guildPermissionGrant.deleteMany({
        where: { guildId, userDiscordId: discordId },
      });
      const reminderDel = await tx.reminder.deleteMany({
        where: { userId: discordId, guildId },
      });

      let factionMemberships = 0;
      if (factionIds.length > 0) {
        const memberDel = await tx.factionMember.deleteMany({
          where: {
            factionId: { in: factionIds },
            userDiscordId: discordId,
          },
        });
        factionMemberships = memberDel.count;
      }

      // Leitungsfelder sind unabhaengig von FactionMember und muessen separat
      // neutralisiert werden. Jede Mutation bleibt guildgescoppt und aendert
      // nur genau das Feld, das auf den austretenden User zeigt.
      const [leader, deputy, treasurer] = await Promise.all([
        tx.faction.updateMany({
          where: { guildId, leaderDiscordId: discordId },
          data: { leaderDiscordId: null },
        }),
        tx.faction.updateMany({
          where: { guildId, deputyDiscordId: discordId },
          data: { deputyDiscordId: null },
        }),
        tx.faction.updateMany({
          where: { guildId, treasurerDiscordId: discordId },
          data: { treasurerDiscordId: null },
        }),
      ]);
      const factionLeadershipRefs = leader.count + deputy.count + treasurer.count;

      let levelData = 0;
      let xpRecords = 0;
      let moderationCases = 0;
      if (dbUser) {
        const [levelDel, xpDel, casesDel] = await Promise.all([
          tx.levelData.deleteMany({ where: { userId: dbUser.id, guildId } }),
          tx.xpRecord.deleteMany({ where: { userId: dbUser.id, guildId } }),
          // Nur Faelle, in denen der Verlassende das ZIEL war. Faelle, in denen
          // er selbst Moderator war, bleiben als Audit-Trail anderer User.
          tx.moderationCase.deleteMany({ where: { guildId, targetUserId: dbUser.id } }),
        ]);
        levelData = levelDel.count;
        xpRecords = xpDel.count;
        moderationCases = casesDel.count;
      }

      return {
        performed: true as const,
        levelData,
        xpRecords,
        moderationCases,
        reminders: reminderDel.count,
        permissionGrants: permissionDel.count,
        factionMemberships,
        factionLeadershipRefs,
        affectedFactionIds: factionIds,
        userId: dbUser?.id ?? null,
      };
    });

    logAudit('GUILD_MEMBER_DATA_CLEANUP', 'MODERATION', {
      guildId,
      discordId,
      userId: result.userId,
      levelData: result.levelData,
      xpRecords: result.xpRecords,
      moderationCases: result.moderationCases,
      reminders: result.reminders,
      permissionGrants: result.permissionGrants,
      factionMemberships: result.factionMemberships,
      factionLeadershipRefs: result.factionLeadershipRefs,
    });

    // Ein Guild-Austritt entfernt Discord-Rollen ohnehin serverseitig. Nach dem
    // atomaren DB-Cut muessen nur noch die persistenten Faction-Embeds/Listen den
    // neuen Zustand spiegeln. Das ist bewusst best-effort: Discord-Ausfall darf
    // einen bereits erfolgreichen Datenschutz-/Security-Cleanup nie zurueckrollen.
    if (result.factionMemberships > 0 || result.factionLeadershipRefs > 0) {
      const client = tryGetDashboardClient();
      if (client) {
        for (const factionId of result.affectedFactionIds) {
          await postFactionEmbed(client, factionId).catch(error => {
            logger.warn(`Leave-Cleanup Faction-Embed ${factionId} konnte nicht aktualisiert werden: ${(error as Error).message}`);
          });
        }
        await postFactionList(client, guildId).catch(error => {
          logger.warn(`Leave-Cleanup Faction-Liste ${guildId} konnte nicht aktualisiert werden: ${(error as Error).message}`);
        });
      }
    }

    return {
      performed: true,
      levelData: result.levelData,
      xpRecords: result.xpRecords,
      moderationCases: result.moderationCases,
      reminders: result.reminders,
      permissionGrants: result.permissionGrants,
      factionMemberships: result.factionMemberships,
      factionLeadershipRefs: result.factionLeadershipRefs,
    };
  } catch (e) {
    logger.error(
      `cleanupGuildMemberData fehlgeschlagen (guild=${guildId}, user=${discordId}): ${(e as Error).message}`,
    );
    return { performed: false, reason: 'transaction_failed', ...empty };
  }
}
