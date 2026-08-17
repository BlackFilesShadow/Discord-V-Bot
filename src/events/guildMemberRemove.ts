import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
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

    // Den durable Leave-Barrier so frueh wie moeglich anlegen. Insbesondere darf
    // ein langsamer Discord-Goodbye-Versand kein Rejoin-/Relink-Fenster oeffnen.
    // AUS bedeutet weiterhin wirklich AUS: Dann wird kein Cleanup-Request erzeugt.
    try {
      const leaveCfg = await getLeaveCleanupConfig(m.guild.id);
      if (leaveCfg.deletePlayerDataOnLeave) {
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
    // markieren. Das Profil bleibt fuer Goodbye/Recognition erhalten.
    await syncMemberProfile(m);
    await markMemberLeft(m.guild.id, m.user.id);

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
