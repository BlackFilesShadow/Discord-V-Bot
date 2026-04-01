import { Events, MessageReaction, User, PartialMessageReaction, PartialUser, EmbedBuilder } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { votePoll, getPollVotes, createPollEmbed, PollOption } from '../modules/polls/pollSystem';
import { grantEventXp } from '../modules/xp/xpManager';

/**
 * MessageReactionAdd-Event: Reaktion auf eine Nachricht.
 * Sektion 6: Giveaway-Teilnahme per Reaktion.
 * Sektion 9: Reaction-Roles.
 * Sektion 10: Poll-Votes per Reaktion.
 */
const messageReactionAddEvent: BotEvent = {
  name: Events.MessageReactionAdd,
  execute: async (reaction: unknown, user: unknown) => {
    const r = reaction as MessageReaction | PartialMessageReaction;
    const u = user as User | PartialUser;

    // Bots ignorieren
    if (u.bot) return;

    // Partielle Daten nachladen
    if (r.partial) {
      try {
        await r.fetch();
      } catch {
        return;
      }
    }

    const messageId = r.message.id;
    const emoji = r.emoji.name || r.emoji.id || '';

    try {
      // ===== SEKTION 6: GIVEAWAY-TEILNAHME =====
      const giveaway = await prisma.giveaway.findFirst({
        where: {
          messageId,
          status: 'ACTIVE',
          endsAt: { gt: new Date() },
        },
      });

      if (giveaway) {
        // Prüfe Custom-Emoji
        const requiredEmoji = giveaway.customEmoji || '🎉';
        if (emoji !== requiredEmoji && r.emoji.toString() !== requiredEmoji) return;

        const dbUser = await prisma.user.findUnique({
          where: { discordId: u.id },
        });

        if (!dbUser) return;

        // Mindestrolle prüfen
        if (giveaway.minRole && r.message.guild) {
          const member = await r.message.guild.members.fetch(u.id);
          if (!member.roles.cache.has(giveaway.minRole)) {
            try {
              await u.send(`❌ Du benötigst eine bestimmte Rolle, um an diesem Giveaway teilzunehmen.`);
            } catch { /* DMs deaktiviert */ }
            return;
          }
        }

        // Blacklist-Rollen prüfen
        if (giveaway.blacklistRoles && r.message.guild) {
          const member = await r.message.guild.members.fetch(u.id);
          const blacklisted = giveaway.blacklistRoles as string[];
          if (blacklisted.some(roleId => member.roles.cache.has(roleId))) {
            return;
          }
        }

        // Teilnahme registrieren (Mehrfachteilnahme verhindert durch unique constraint)
        try {
          await prisma.giveawayEntry.create({
            data: {
              giveawayId: giveaway.id,
              userId: dbUser.id,
            },
          });

          logAudit('GIVEAWAY_ENTER', 'GIVEAWAY', {
            giveawayId: giveaway.id,
            userId: dbUser.id,
            prize: giveaway.prize,
          });
        } catch {
          // Bereits teilgenommen (unique constraint violation)
        }
        return;
      }

      // ===== SEKTION 9: REACTION-ROLES =====
      const reactionRole = await prisma.autoRole.findFirst({
        where: {
          triggerType: 'REACTION',
          messageId,
          triggerValue: emoji,
          isActive: true,
        },
      });

      if (reactionRole && r.message.guild) {
        const member = await r.message.guild.members.fetch(u.id);

        // Prüfe Whitelist/Blacklist
        if (reactionRole.whitelistRoles) {
          const whitelist = reactionRole.whitelistRoles as string[];
          if (!whitelist.some(roleId => member.roles.cache.has(roleId))) return;
        }

        if (reactionRole.blacklistRoles) {
          const blacklist = reactionRole.blacklistRoles as string[];
          if (blacklist.some(roleId => member.roles.cache.has(roleId))) return;
        }

        try {
          await member.roles.add(reactionRole.roleId, 'Reaction-Role');

          const dbUser = await prisma.user.findUnique({ where: { discordId: u.id } });
          if (dbUser) {
            await prisma.userRoleAssignment.create({
              data: {
                userId: dbUser.id,
                roleId: reactionRole.roleId,
                assignedBy: 'auto',
                reason: 'Reaction-Role',
                expiresAt: reactionRole.expiresAt,
              },
            });
          }

          logAudit('REACTION_ROLE_ASSIGNED', 'ROLE', {
            discordId: u.id,
            roleId: reactionRole.roleId,
            messageId,
          });
        } catch (e) {
          logger.error('Reaction-Role Fehler:', e);
        }
        return;
      }

      // ===== SEKTION 10: POLL-VOTES PER REAKTION =====
      const poll = await prisma.poll.findFirst({
        where: {
          messageId,
          status: 'ACTIVE',
        },
      });

      if (poll) {
        const options = poll.options as unknown as PollOption[];
        const matchedOption = options.find(opt => opt.emoji === emoji);
        if (!matchedOption) return;

        const dbUser = await prisma.user.findUnique({ where: { discordId: u.id } });
        if (!dbUser) return;

        // Bei Einzelwahl: vorherige Reaktionen entfernen
        if (!poll.allowMultiple) {
          const existingVotes = await prisma.pollVote.findMany({
            where: { pollId: poll.id, userId: dbUser.id },
          });

          if (existingVotes.length > 0) {
            // Bestehende Stimme(n) aus DB löschen
            await prisma.pollVote.deleteMany({
              where: { pollId: poll.id, userId: dbUser.id },
            });
            await prisma.poll.update({
              where: { id: poll.id },
              data: { totalVotes: { decrement: existingVotes.length } },
            });

            // Vorherige Emoji-Reaktionen des Users entfernen
            for (const oldVote of existingVotes) {
              if (oldVote.optionId === matchedOption.id) continue;
              const oldOption = options.find(o => o.id === oldVote.optionId);
              if (oldOption) {
                const msgReactions = r.message.reactions.cache.get(oldOption.emoji);
                if (msgReactions) {
                  try { await msgReactions.users.remove(u.id); } catch {}
                }
              }
            }
          }
        }

        // Stimme abgeben
        const result = await votePoll(poll.id, dbUser.id, matchedOption.id);

        if (result.success) {
          try { await grantEventXp(dbUser.id, 5, 'POLL_VOTE', poll.id); } catch {}
        } else if (result.message.includes('bereits')) {
          // Bereits für diese Option gestimmt → Reaktion entfernen
          try { await r.users.remove(u.id); } catch {}
          return;
        }

        // Live-Embed updaten
        try {
          const votes = await getPollVotes(poll.id);
          const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
          const embed = createPollEmbed(
            poll.title, poll.description, options, poll.pollType,
            poll.endsAt, votes, totalVotes,
          );
          embed.setFooter({ text: `Poll-ID: ${poll.id} | Reagiere oder nutze /poll abstimmen` });
          await r.message.edit({ embeds: [embed] });
        } catch {}
      }
    } catch (error) {
      logger.error('MessageReactionAdd Fehler:', error);
    }
  },
};

export default messageReactionAddEvent;
