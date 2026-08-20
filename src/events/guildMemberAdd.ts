import { Events, GuildMember, TextChannel } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { detectRaid } from '../utils/rateLimiter';
import { getWelcomeConfig, renderWelcomeMessage, sendWelcomeMessages } from '../modules/welcome/welcomeManager';
import { resolveCustomEmotes } from '../modules/ai/emoteResolver';
import { syncMemberProfile } from '../modules/ai/memberAwareness';
import { hasOpenLeaveCleanupRequest } from '../modules/moderation/leaveCleanupGuard';

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
      // Defense in depth fuer Rejoins: Direct-Grants gehoeren zur vorherigen
      // Mitgliedschaftsepoche und werden nicht still reaktiviert. Normalerweise
      // entfernt bereits GuildMemberRemove diese Zeile; dieser Cut schliesst
      // Event-/DB-Ausfallfenster beim naechsten Join.
      //
      // Wichtig: Nur Grants, deren updatedAt VOR dem aktuellen Discord-joinedAt
      // liegt, werden entfernt. Ein Owner kann damit nach dem Rejoin bereits
      // bewusst einen frischen Grant vergeben, ohne dass ein spaeter laufender
      // Cleanup denselben neuen Grant wieder loescht (Rejoin-Lost-Update).
      // Fehlendes joinedAt => Cleanup auslassen; der Authorizer bleibt trotzdem
      // fail-closed fuer Direct-Grants ohne aktuelle Mitgliedschaftsepoche.
      try {
        if (m.joinedAt) {
          const staleGrant = await prisma.guildPermissionGrant.deleteMany({
            where: {
              guildId: m.guild.id,
              userDiscordId: m.user.id,
              updatedAt: { lt: m.joinedAt },
            },
          });
          if (staleGrant.count > 0) {
            logAudit('STALE_PERM_GRANT_CLEARED_ON_JOIN', 'SECURITY', {
              guildId: m.guild.id,
              discordId: m.user.id,
              joinedAt: m.joinedAt.toISOString(),
              count: staleGrant.count,
            });
          }
        } else {
          logger.warn(`Stale Direct-Grant-Cleanup beim Join uebersprungen: joinedAt fehlt (${m.user.id}@${m.guild.id}).`);
        }
      } catch (permissionError) {
        logger.error(`Stale Direct-Grant-Cleanup beim Join fehlgeschlagen (${m.user.id}@${m.guild.id}):`, permissionError);
      }

      // User-1: Rejoin/Join muss das exakt guild-gescoppte Recognition-Profil
      // deterministisch auf aktiv setzen, bevor nachgelagerte Join-Logik laeuft.
      // Leave-1G nutzt den neuen joinedAt-Zeitpunkt als durable Rejoin-Evidenz.
      await syncMemberProfile(m);

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

      // Ein Rejoin darf keine neue Level-/Leaderboard-Epoche anlegen, solange
      // der vorherige Leave-Cleanup noch PENDING/IN_PROGRESS/FAILED ist. Der
      // Worker stellt nach dem letzten destruktiven Cutoff eine frische Baseline
      // her. Guard-Fehler sind fail-closed fuer Player-State, ohne Welcome/
      // AutoRoles fuer die aktuelle Discord-Mitgliedschaft zu blockieren.
      let leaveCleanupOpen = true;
      try {
        leaveCleanupOpen = await hasOpenLeaveCleanupRequest(m.guild.id, m.user.id);
      } catch (guardError) {
        logger.error(`Rejoin Leave-Cleanup-Guard fehlgeschlagen: ${String(guardError)}`);
      }

      if (!leaveCleanupOpen) {
        await prisma.levelData.upsert({
          where: { userId_guildId: { userId: user.id, guildId: m.guild.id } },
          create: { userId: user.id, guildId: m.guild.id },
          update: {},
        });
      } else {
        logger.info(`Rejoin-Level-Baseline bis Leave-Cleanup-Abschluss gesperrt: ${m.user.id}@${m.guild.id}`);
      }

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

      // Economy-Startguthaben wird absichtlich NICHT beim Discord-Join vergeben.
      // Es gehoert zur nachgewiesenen DayZ-Account-Verknuepfung und wird dort
      // exakt einmal pro Guild+Gameserver+Discord-Account gebucht.

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
            const memberCount = m.guild.memberCount;

            const messageText = renderWelcomeMessage(wcfg.message, {
              user: userMention,
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
