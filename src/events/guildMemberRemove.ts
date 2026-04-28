import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import { markMemberLeft } from '../modules/ai/memberAwareness';
import { cleanupGuildMemberData } from '../modules/moderation/guildMemberCleanup';

/**
 * GuildMemberRemove-Event: Nutzer verlässt den Server.
 * Sektion 11: Detaillierte Logs (Join/Leave).
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

    // Phase 18: Member-Profil als verlassen markieren (best-effort).
    void markMemberLeft(m.guild.id, m.user.id);

    // Guild-spezifischer Daten-Cleanup: Moderation + Aktivitaetsdaten dieser Guild
    // entfernen, damit DB nicht mit Karteileichen waechst. Hersteller-/Cross-Guild-
    // Daten (Packages, Uploads, User-Stamm) bleiben erhalten.
    cleanupGuildMemberData(m.guild.id, m.user.id)
      .then(res => {
        if (res.performed) {
          logger.info(
            `Guild-Cleanup ${m.user.id}@${m.guild.id}: ` +
              `level=${res.levelData}, xp=${res.xpRecords}, ` +
              `cases=${res.moderationCases}, reminders=${res.reminders}`,
          );
        }
      })
      .catch(e => {
        logger.error(`Guild-Cleanup-Fehler: ${(e as Error).message}`);
      });

    logger.info(`Nutzer verlassen: ${m.user.username} (${m.user.id})`);
  },
};

export default guildMemberRemoveEvent;
