import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
import prisma from '../database/prisma';
import { directGrantBelongsToMembership } from '../modules/permissions/access';
import { logger, logAudit } from '../utils/logger';
import { markMemberLeft, syncMemberProfile } from '../modules/ai/memberAwareness';
import { getLeaveCleanupConfig } from '../modules/moderation/leaveCleanupConfig';
import { enqueueLeaveCleanupRequest } from '../modules/moderation/leaveCleanupSaga';
import { sanitizeLeaveCleanupError } from '../modules/moderation/leaveCleanupSecurity';
import { sendConfiguredGoodbye } from '../modules/welcome/goodbyeManager';

/**
 * GuildMemberRemove-Event: Nutzer verlaesst den Server.
 * Destruktiver Spieler-Cleanup ist guild-spezifisch opt-in und wird niemals
 * direkt im Gateway-Event ausgefuehrt, sondern nur persistent eingequeued.
 *
 * Authorization-State ist davon getrennt: direkte Guild-Permissions werden
 * beim Austritt best-effort entfernt, ABER nur wenn die persistierte Grant-
 * Generation noch exakt zur gerade verlassenen Discord-Mitgliedschaft gehoert.
 * Ein verspaetetes Leave-Event darf einen bereits nach Rejoin neu vergebenen
 * Grant niemals wieder loeschen.
 */
const guildMemberRemoveEvent: BotEvent = {
  name: Events.GuildMemberRemove,
  execute: async (member: unknown) => {
    const m = member as GuildMember;

    logAudit('MEMBER_LEAVE', 'SYSTEM', {
      discordId: m.user.id,
      username: m.user.username,
      guildId: m.guild.id,
      joinedAt: m.joinedAt?.toISOString(),
      roles: m.roles.cache.map(r => r.name),
    });

    // Permission-Revoke ist KEIN optionaler Player-Data-Cleanup. Die eigentliche
    // Authorization bleibt zusaetzlich ueber Live-Membership fail-closed.
    //
    // Race-/ABA-Schutz:
    // 1) aktuellen Direct-Grant lesen;
    // 2) nur dann als "dieser Leave" akzeptieren, wenn seine Membership-Epoche
    //    zu m.joinedAt gehoert;
    // 3) Delete per id+updatedAt als CAS. Wird zwischen Read und Delete ein
    //    frischer Rejoin-Grant geschrieben, ist count=0 und der neue Grant lebt.
    try {
      if (m.joinedAt) {
        const existingGrant = await prisma.guildPermissionGrant.findUnique({
          where: {
            guildId_userDiscordId: {
              guildId: m.guild.id,
              userDiscordId: m.user.id,
            },
          },
          select: {
            id: true,
            permissions: true,
            updatedAt: true,
          },
        });

        if (existingGrant && directGrantBelongsToMembership(
          existingGrant.permissions,
          existingGrant.updatedAt,
          m.joinedAt,
        )) {
          const revoked = await prisma.guildPermissionGrant.deleteMany({
            where: {
              id: existingGrant.id,
              guildId: m.guild.id,
              userDiscordId: m.user.id,
              updatedAt: existingGrant.updatedAt,
            },
          });
          if (revoked.count > 0) {
            logAudit('PERM_GRANT_REVOKED_ON_LEAVE', 'SECURITY', {
              guildId: m.guild.id,
              discordId: m.user.id,
              membershipJoinedAt: m.joinedAt.toISOString(),
              count: revoked.count,
            });
          } else {
            logger.info(`Direct-Grant-Revoke beim Leave durch CAS uebersprungen (Grant inzwischen geaendert): ${m.user.id}@${m.guild.id}`);
          }
        }
      } else {
        // Ohne joinedAt kann dieses Event keiner Membership-Generation sicher
        // zugeordnet werden. Nicht destruktiv raten; Authorizer bleiben trotzdem
        // fail-closed und der Rejoin-Pfad bereinigt alte Generationen separat.
        logger.warn(`Direct-Grant-Revoke beim Leave uebersprungen: joinedAt fehlt (${m.user.id}@${m.guild.id}).`);
      }
    } catch (permissionError) {
      logger.error(`Direct-Grant-Revoke beim Leave fehlgeschlagen (${m.user.id}@${m.guild.id}):`, permissionError);
    }

    // Den durable Leave-Barrier so frueh wie moeglich anlegen. Insbesondere darf
    // ein langsamer Discord-Goodbye-Versand kein Rejoin-/Relink-Fenster oeffnen.
    // AUS bedeutet weiterhin wirklich AUS: Dann wird kein Cleanup-Request erzeugt.
    let cleanupEnabled = false;
    try {
      const leaveCfg = await getLeaveCleanupConfig(m.guild.id);
      cleanupEnabled = leaveCfg.deletePlayerDataOnLeave;
      if (cleanupEnabled) {
        const queued = await enqueueLeaveCleanupRequest({
          guildId: m.guild.id,
          discordId: m.user.id,
        });
        logger.info(
          `Leave-Cleanup ${queued.created ? 'eingequeued' : 'bereits vorhanden'}: ${m.user.id}@${m.guild.id}`,
        );
      }
    } catch (cleanupError) {
      logger.error(`Leave-Cleanup Enqueue/Config fehlgeschlagen: ${sanitizeLeaveCleanupError(cleanupError)}`);
    }

    // Letzten Gateway-Zustand guildgenau persistieren und danach als verlassen
    // markieren. Das Profil bleibt bis zum Worker-Finalizer fuer Goodbye/
    // Rejoin-Erkennung erhalten.
    await syncMemberProfile(m);
    await markMemberLeft(m.guild.id, m.user.id);

    // Leave-1G: Ein Rejoin kann waehrend eines alten Cleanups erfolgen und der
    // Nutzer direkt wieder austreten. Falls der erste Job zwischen dem fruehen
    // Enqueue und markMemberLeft bereits COMPLETE wurde, muss dieser zweite
    // Leave einen neuen Job erhalten. Ist der erste Job noch offen, dedupliziert
    // enqueueLeaveCleanupRequest denselben Guild+User-Key race-sicher.
    if (cleanupEnabled) {
      try {
        const confirmed = await enqueueLeaveCleanupRequest({
          guildId: m.guild.id,
          discordId: m.user.id,
        });
        if (confirmed.created) {
          logger.warn(`Leave-Cleanup nach Left-Marker erneut eingequeued: ${m.user.id}@${m.guild.id}`);
        }
      } catch (cleanupError) {
        logger.error(`Leave-Cleanup Post-Left-Enqueue fehlgeschlagen: ${sanitizeLeaveCleanupError(cleanupError)}`);
      }
    }

    // Goodbye bleibt best-effort und liegt bewusst NACH dem durable Enqueue.
    try {
      const goodbyeResult = await sendConfiguredGoodbye(m);
      if (goodbyeResult === 'sent') {
        logger.info(`Goodbye gesendet: ${m.user.id}@${m.guild.id}`);
      } else if (goodbyeResult === 'missing_channel') {
        logger.warn(`Goodbye-Channel fehlt oder ist nicht sendbar: Guild ${m.guild.id}`);
      }
    } catch (goodbyeError) {
      logger.error(`Goodbye-System Fehler fuer ${m.user.id}@${m.guild.id}:`, goodbyeError);
    }

    logger.info(`Nutzer verlassen: ${m.user.username} (${m.user.id})`);
  },
};

export default guildMemberRemoveEvent;
