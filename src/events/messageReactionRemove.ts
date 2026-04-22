import { Events, MessageReaction, User, PartialMessageReaction, PartialUser } from 'discord.js';
import { BotEvent } from '../types';
import { logger, logAudit } from '../utils/logger';
import prisma from '../database/prisma';
import { getPollVotes, createPollEmbed, PollOption } from '../modules/polls/pollSystem';
import { createGiveawayEmbed } from '../modules/giveaway/giveawayManager';

/**
 * MessageReactionRemove-Event:
 * - Poll: Stimme zurückziehen, wenn User Reaktion entfernt.
 * - Giveaway: Teilnahme entfernen, wenn User Reaktion entfernt.
 */
const messageReactionRemoveEvent: BotEvent = {
  name: Events.MessageReactionRemove,
  execute: async (reaction: unknown, user: unknown) => {
    const r = reaction as MessageReaction | PartialMessageReaction;
    const u = user as User | PartialUser;

    if (u.bot) return;

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
      // ===== GIVEAWAY: Teilnahme entfernen =====
      const giveaway = await prisma.giveaway.findFirst({
        where: { messageId, status: 'ACTIVE' },
      });

      if (giveaway) {
        const requiredEmoji = giveaway.customEmoji || '🎉';
        if (emoji !== requiredEmoji && r.emoji.toString() !== requiredEmoji) return;

        const dbUser = await prisma.user.findUnique({ where: { discordId: u.id } });
        if (!dbUser) return;

        const deleted = await prisma.giveawayEntry.deleteMany({
          where: { giveawayId: giveaway.id, userId: dbUser.id },
        });

        if (deleted.count > 0) {
          logAudit('GIVEAWAY_LEAVE', 'GIVEAWAY', {
            giveawayId: giveaway.id,
            userId: dbUser.id,
            prize: giveaway.prize,
          });

          // Embed mit neuer Teilnehmerzahl aktualisieren
          try {
            const participantCount = await prisma.giveawayEntry.count({
              where: { giveawayId: giveaway.id },
            });
            const creator = await prisma.user.findUnique({
              where: { id: giveaway.creatorId },
              select: { username: true },
            });
            const embed = createGiveawayEmbed(giveaway, participantCount, creator?.username);
            embed.addFields({ name: '🆔 ID', value: giveaway.id, inline: false });
            await r.message.edit({ embeds: [embed] });
          } catch (e) {
            logger.error('Giveaway-Embed-Update nach Reaction-Remove fehlgeschlagen:', e);
          }
        }
        return;
      }

      // ===== POLL: Stimme zurückziehen =====
      const poll = await prisma.poll.findFirst({
        where: { messageId, status: 'ACTIVE' },
      });

      if (poll) {
        const options = poll.options as unknown as PollOption[];
        const matchedOption = options.find(opt => opt.emoji === emoji);
        if (!matchedOption) return;

        const dbUser = await prisma.user.findUnique({ where: { discordId: u.id } });
        if (!dbUser) return;

        const deleted = await prisma.pollVote.deleteMany({
          where: { pollId: poll.id, userId: dbUser.id, optionId: matchedOption.id },
        });

        if (deleted.count > 0) {
          await prisma.poll.update({
            where: { id: poll.id },
            data: { totalVotes: { decrement: deleted.count } },
          });

          logAudit('POLL_VOTE_REMOVED', 'POLL', {
            pollId: poll.id,
            userId: dbUser.id,
            optionId: matchedOption.id,
          });

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
          } catch (e) {
            logger.error('Poll-Embed-Update nach Reaction-Remove fehlgeschlagen:', e);
          }
        }
      }
    } catch (error) {
      logger.error('MessageReactionRemove Fehler:', error);
    }
  },
};

export default messageReactionRemoveEvent;
