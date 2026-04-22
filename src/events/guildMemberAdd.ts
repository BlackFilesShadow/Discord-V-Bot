import { Events, GuildMember, TextChannel, AttachmentBuilder } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { generateGuid } from '../utils/guid';
import { detectRaid } from '../utils/rateLimiter';
import { getWelcomeConfig, renderWelcomeMessage } from '../modules/welcome/welcomeManager';
import { answerQuestion } from '../modules/ai/aiHandler';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';

// Anti-Raid: Speichert Join-Timestamps
const recentJoins: Map<string, number[]> = new Map();

/**
 * GuildMemberAdd-Event: Neuer Nutzer tritt bei.
 * Sektion 1: GUID-Vergabe, Sektion 9: Auto-Rollen.
 */
const guildMemberAddEvent: BotEvent = {
  name: Events.GuildMemberAdd,
  execute: async (member: unknown) => {
    const m = member as GuildMember;

    // Anti-Raid Detection (Sektion 4)
    const guildId = m.guild.id;
    const now = Date.now();
    const joins = recentJoins.get(guildId) || [];
    joins.push(now);
    // Nur Joins der letzten 10 Sekunden behalten
    const recentWindow = joins.filter(t => now - t < 10000);
    recentJoins.set(guildId, recentWindow);

    const isRaid = await detectRaid(guildId, recentWindow.length);
    if (isRaid) {
      logger.warn(`🚨 RAID ERKANNT auf Server ${guildId}! ${recentWindow.length} Joins in 10s.`);
      // Hier könnte automatisches Lockdown implementiert werden
    }

    try {
      // User in DB registrieren mit GUID (Sektion 1)
      const user = await prisma.user.upsert({
        where: { discordId: m.user.id },
        create: {
          discordId: m.user.id,
          username: m.user.username,
          discriminator: m.user.discriminator || '',
        },
        update: {
          username: m.user.username,
          discriminator: m.user.discriminator || '',
        },
      });

      // Level-Data initialisieren (Sektion 8)
      await prisma.levelData.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      // GDPR Consent Entry (Sektion 4: DSGVO)
      await prisma.gdprConsent.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      // Auto-Rollen vergeben (Sektion 9: Rollen nach Beitritt)
      const autoRoles = await prisma.autoRole.findMany({
        where: { triggerType: 'JOIN', isActive: true },
      });

      for (const autoRole of autoRoles) {
        // Prüfe Ablaufdatum
        if (autoRole.expiresAt && autoRole.expiresAt < new Date()) continue;

        try {
          await m.roles.add(autoRole.roleId, 'Auto-Rolle bei Beitritt');

          await prisma.userRoleAssignment.create({
            data: {
              userId: user.id,
              roleId: autoRole.roleId,
              assignedBy: 'auto',
              reason: 'Auto-Rolle bei Server-Beitritt',
              expiresAt: autoRole.expiresAt,
            },
          });
        } catch (roleError) {
          logger.error(`Auto-Rolle ${autoRole.roleId} konnte nicht vergeben werden:`, roleError);
        }
      }

      // Audit-Log
      logAudit('MEMBER_JOIN', 'SYSTEM', {
        userId: user.id,
        discordId: m.user.id,
        username: m.user.username,
        guildId: m.guild.id,
        autoRolesAssigned: autoRoles.length,
      });

      logger.info(`Neuer Nutzer: ${m.user.username} (GUID: ${user.id})`);

      // ===== WELCOME-NACHRICHT (mit optionalen Medien & AI) =====
      try {
        const wcfg = await getWelcomeConfig(m.guild.id);
        if (wcfg && wcfg.enabled && wcfg.channelId) {
          const channel = m.guild.channels.cache.get(wcfg.channelId) as TextChannel | undefined;
          if (channel?.isTextBased()) {
            const userMention = `<@${m.user.id}>`;
            const memberCount = m.guild.memberCount;

            let messageText: string;
            if (wcfg.mode === 'ai') {
              const prompt = renderWelcomeMessage(wcfg.message, {
                user: m.user.username,
                guild: m.guild.name,
                memberCount,
              });
              const r = await answerQuestion(
                `Erzeuge eine kurze, freundliche, einladende Begr\u00fc\u00dfung. Anweisung: ${prompt}\n\nNeuer Nutzer: ${m.user.username}\nServer: ${m.guild.name}\nMitgliederzahl: ${memberCount}\n\nGib NUR den Begr\u00fc\u00dfungstext zur\u00fcck (max. 600 Zeichen).`
              );
              messageText = r.success && r.result ? `${userMention} ${r.result.trim()}` : `${userMention} Willkommen auf ${m.guild.name}!`;
            } else {
              messageText = renderWelcomeMessage(wcfg.message, {
                user: userMention,
                guild: m.guild.name,
                memberCount,
              });
            }

            const files = wcfg.mediaUrl ? [new AttachmentBuilder(wcfg.mediaUrl)] : undefined;
            const finalText = resolveCustomEmotes(messageText, m.guild);
            await channel.send({ content: finalText.slice(0, 2000), files }).catch(err => {
              logger.warn(`Welcome-Nachricht konnte nicht gesendet werden:`, err);
            });
          }
        }
      } catch (welcomeErr) {
        logger.error('Welcome-System Fehler:', welcomeErr);
      }
    } catch (error) {
      logger.error(`Fehler bei guildMemberAdd für ${m.user.username}:`, error);
    }
  },
};

export default guildMemberAddEvent;
