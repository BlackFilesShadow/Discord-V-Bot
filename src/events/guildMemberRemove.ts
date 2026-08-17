import { Events, GuildMember } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import { markMemberLeft, syncMemberProfile } from '../modules/ai/memberAwareness';
import { cleanupGuildMemberData } from '../modules/moderation/guildMemberCleanup';
import { sendConfiguredGoodbye } from '../modules/welcome/goodbyeManager';

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

    // User-1 / Goodbye-1: Zuerst den letzten Gateway-Zustand exakt fuer diese
    // Guild persistieren, danach als verlassen markieren. Das Goodbye liest
    // anschliessend genau dieses GuildMemberProfile und niemals Cross-Guild-
    // Recognition- oder Authorization-Daten.
    await syncMemberProfile(m);
    await markMemberLeft(m.guild.id, m.user.id);

    // Goodbye ist best-effort und darf einen nachgelagerten Cleanup niemals
    // blockieren. Fehlende/ungueltige Channels werden sichtbar geloggt.
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

    // Guild-spezifischer Daten-Cleanup: Moderation + Aktivitaetsdaten dieser Guild
    // entfernen, damit DB nicht mit Karteileichen waechst. Hersteller-/Cross-Guild-
    // Daten (Packages, Uploads, User-Stamm) bleiben erhalten.
    // Der umfassende optionale Leave/Reset-Cleanup wird in der separaten
    // LeaveCleanup-Etappe aus Tracker #73 auf einen Dashboard-Toggle umgestellt.
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
