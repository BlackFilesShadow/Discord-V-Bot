import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
import prisma from '../database/prisma';
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
 * IMMER beim Austritt entfernt. Ein ausgestiegener User darf keinen Grant fuer
 * einen spaeteren Rejoin konservieren, auch wenn Spieler-Daten-Cleanup AUS ist.
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

    // Permission-Revoke ist KEIN optionaler Player-Data-Cleanup, sondern eine
    // Authorization-Invariante. REST/Socket pruefen Mitgliedschaft zusaetzlich
    // fail-closed, falls dieser best-effort DB-Cut temporaer fehlschlaegt.
    try {
      const revoked = await prisma.guildPermissionGrant.deleteMany({
        where: { guildId: m.guild.id, userDiscordId: m.user.id },
      });
      if (revoked.count > 0) {
        logAudit('PERM_GRANT_REVOKED_ON_LEAVE', 'SECURITY', {
          guildId: m.guild.id,
          discordId: m.user.id,
          count: revoked.count,
        });
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
