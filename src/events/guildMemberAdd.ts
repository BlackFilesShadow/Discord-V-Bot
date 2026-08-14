import { Events, GuildMember, TextChannel } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { detectRaid } from '../utils/rateLimiter';
import { getWelcomeConfig, renderWelcomeMessage, sendWelcomeMessages } from '../modules/welcome/welcomeManager';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';
import { syncMemberProfile } from '../modules/ai/memberAwareness';
import { maybeGrantStartBalance } from '../modules/economy/repository';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../types/scope';

const recentJoins: Map<string, number[]> = new Map();

const guildMemberAddEvent: BotEvent = {
  name: Events.GuildMemberAdd,
  execute: async (member: unknown) => {
    const m = member as GuildMember;

    const guildId = m.guild.id;
    const now = Date.now();
    const joins = recentJoins.get(guildId) || [];
    joins.push(now);
    const recentWindow = joins.filter(t => now - t < 10000);
    recentJoins.set(guildId, recentWindow);

    const isRaid = await detectRaid(guildId, recentWindow.length);
    if (isRaid) {
      logger.warn(`🚨 RAID ERKANNT auf Server ${guildId}! ${recentWindow.length} Joins in 10s.`);
    }

    try {
      void syncMemberProfile(m);

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

      await prisma.levelData.upsert({
        where: { userId_guildId: { userId: user.id, guildId: m.guild.id } },
        create: { userId: user.id, guildId: m.guild.id },
        update: {},
      });

      await prisma.gdprConsent.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });

      const autoRoles = await prisma.autoRole.findMany({
        where: { guildId: m.guild.id, triggerType: 'JOIN', isActive: true },
      });

      for (const autoRole of autoRoles) {
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

      try {
        // ECO-S03: Ein Discord-Join besitzt bei Multi-Server-Guilds keinen
        // eindeutigen Gameserver-Kontext. Startguthaben darf deshalb NIEMALS
        // auf mehrere Server kopiert oder per "kleinster Slot" geraten werden.
        const usableServers = await prisma.nitradoConnection.findMany({
          where: {
            guildId: m.guild.id,
            status: 'ACTIVE',
            slot: { gte: 1, lte: 4 },
            nitradoServerId: { not: null },
          },
          select: { id: true },
          orderBy: [{ slot: 'asc' }, { id: 'asc' }],
          take: 2,
        });

        if (usableServers.length === 1) {
          const nitradoConnId = asNitradoConnId(usableServers[0].id);
          const grantResult = await maybeGrantStartBalance(
            asGuildId(m.guild.id),
            nitradoConnId,
            asUserDiscordId(m.user.id),
          );
          if (grantResult.granted) {
            logAudit('ECON_STARTBALANCE_GRANTED', 'ECONOMY', {
              guildId: m.guild.id,
              nitradoConnId,
              userDiscordId: m.user.id,
              amount: grantResult.amount.toString(),
            });
          }
        } else {
          logger.info(
            `Startguthaben fuer ${m.user.id} in ${m.guild.id} uebersprungen: `
            + `${usableServers.length === 0 ? 'kein' : 'mehr als ein'} eindeutiger aktiver Gameserver.`,
          );
        }
      } catch (econErr) {
        logger.warn(`Startguthaben fuer ${m.user.id} in ${m.guild.id} fehlgeschlagen:`, econErr as Error);
      }

      logAudit('MEMBER_JOIN', 'SYSTEM', {
        userId: user.id,
        discordId: m.user.id,
        username: m.user.username,
        guildId: m.guild.id,
        autoRolesAssigned: autoRoles.length,
      });

      logger.info(`Neuer Nutzer: ${m.user.username} (GUID: ${user.id})`);

      try {
        const wcfg = await getWelcomeConfig(m.guild.id);
        if (wcfg && wcfg.enabled && wcfg.channelId) {
          const channel = m.guild.channels.cache.get(wcfg.channelId) as TextChannel | undefined;
          if (channel?.isTextBased()) {
            const userMention = `<@${m.user.id}>`;
            const displayName = m.displayName || m.user.globalName || m.user.username;
            const memberCount = m.guild.memberCount;

            const messageText = renderWelcomeMessage(wcfg.message, {
              user: displayName,
              mention: userMention,
              guild: m.guild.name,
              memberCount,
            });

            const finalText = resolveCustomEmotes(messageText, m.guild);
            await sendWelcomeMessages(channel, {
              text: finalText,
              mediaUrl: wcfg.mediaUrl,
              mediaLayout: wcfg.mediaLayout,
              mentionUserId: m.user.id,
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
