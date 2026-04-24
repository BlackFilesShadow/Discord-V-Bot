import { Events, GuildMember, TextChannel, AttachmentBuilder } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { generateGuid } from '../utils/guid';
import { detectRaid } from '../utils/rateLimiter';
import { getWelcomeConfig, renderWelcomeMessage } from '../modules/welcome/welcomeManager';
import { answerQuestion } from '../modules/ai/aiHandler';
import { sanitizeForPrompt, withTimeout, safeSend } from '../utils/safeSend';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';
import { syncMemberProfile } from '../modules/ai/memberAwareness';

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
      // Phase 18: Per-Guild Member-Profil pflegen (best-effort).
      void syncMemberProfile(m);

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

      // Level-Data initialisieren für DIESE Guild (Sektion 8, guild-getrennt)
      await prisma.levelData.upsert({
        where: { userId_guildId: { userId: user.id, guildId: m.guild.id } },
        create: { userId: user.id, guildId: m.guild.id },
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
              const safeUser = sanitizeForPrompt(m.user.username, 100);
              const safeGuild = sanitizeForPrompt(m.guild.name, 100);
              const safeTemplate = sanitizeForPrompt(wcfg.message, 1000);
              const prompt = renderWelcomeMessage(safeTemplate, {
                user: safeUser,
                guild: safeGuild,
                memberCount,
              });
              const r = await withTimeout(
                answerQuestion(
                  `Erzeuge eine kurze, freundliche, einladende Begrüßung. Anweisung: ${prompt}\n\nNeuer Nutzer: ${safeUser}\nServer: ${safeGuild}\nMitgliederzahl: ${memberCount}\n\nGib NUR den Begrüßungstext zurück (max. 600 Zeichen).`,
                  { mode: 'welcome' },
                ),
                8000,
                'guildMemberAdd.welcome.ai',
              );
              messageText = r && r.success && r.result ? `${userMention} ${r.result.trim()}` : `${userMention} Willkommen auf ${m.guild.name}!`;
            } else {
              messageText = renderWelcomeMessage(wcfg.message, {
                user: userMention,
                guild: m.guild.name,
                memberCount,
              });
            }

            const files = wcfg.mediaUrl ? [new AttachmentBuilder(wcfg.mediaUrl)] : undefined;
            const finalText = resolveCustomEmotes(messageText, m.guild);
            // safeSend setzt allowedMentions parse:[] – Ping nur fuer den neuen User selbst.
            await safeSend(channel, {
              content: finalText.slice(0, 2000),
              files,
              allowedMentions: { users: [m.user.id], parse: [] },
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
