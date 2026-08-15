import type { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Colors, Brand, vEmbed, percentBar } from '../../utils/embedDesign';
import { safeSend } from '../../utils/safeSend';

let pollSchedulerTimer: NodeJS.Timeout | null = null;

export interface PollOption {
  id: string;
  text: string;
  emoji: string;
}

export interface PollEndResult {
  title: string;
  results: { option: string; votes: number; percentage: number }[];
  totalVotes: number;
  winner: string;
}

export type PollToggleAction = 'ADDED' | 'REMOVED' | 'NONE';

export interface PollToggleResult {
  success: boolean;
  message: string;
  action: PollToggleAction;
}

export const DEFAULT_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * Serialisiert alle zustandsveraendernden Operationen pro Poll direkt in
 * PostgreSQL. Damit greifen mehrere Bot-Instanzen/Worker fuer denselben Poll
 * nicht gleichzeitig auf Vote-Limits, Toggle-Operationen oder Endzustand zu.
 */
async function withPollLock<T>(
  pollId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `poll:${pollId}`,
    );
    return work(tx);
  });
}

async function syncVoteCounter(tx: Prisma.TransactionClient, pollId: string): Promise<number> {
  const totalVotes = await tx.pollVote.count({ where: { pollId } });
  await tx.poll.update({ where: { id: pollId }, data: { totalVotes } });
  return totalVotes;
}

function validatePollForVote(
  poll: { status: string; endsAt: Date | null; options: unknown } | null,
  optionId: string,
): { ok: true } | { ok: false; message: string } {
  if (!poll) return { ok: false, message: 'Umfrage nicht gefunden.' };
  if (poll.status !== 'ACTIVE') return { ok: false, message: 'Umfrage ist nicht mehr aktiv.' };
  if (poll.endsAt && poll.endsAt <= new Date()) return { ok: false, message: 'Umfrage ist abgelaufen.' };
  const options = poll.options as PollOption[];
  if (!options.some(o => o.id === optionId)) return { ok: false, message: 'Ungueltige Option.' };
  return { ok: true };
}

/** Erstellt eine neue Umfrage. */
export async function createPoll(
  creatorId: string,
  channelId: string,
  guildId: string,
  title: string,
  description: string | null,
  options: string[],
  pollType: 'PUBLIC' | 'ANONYMOUS',
  allowMultiple: boolean,
  maxChoices: number,
  durationMinutes: number | null,
  notifyRoleId: string | null,
): Promise<{ pollId: string; options: PollOption[] }> {
  const pollOptions: PollOption[] = options.map((text, i) => ({
    id: `opt_${i}`,
    text,
    emoji: DEFAULT_EMOJIS[i] || `${i + 1}`,
  }));
  const endsAt = durationMinutes ? new Date(Date.now() + durationMinutes * 60 * 1000) : null;
  const poll = await prisma.poll.create({
    data: {
      creatorId, channelId, guildId, title, description,
      options: pollOptions as unknown as any,
      pollType, allowMultiple, maxChoices, endsAt, notifyRoleId,
    },
  });
  logAudit('POLL_CREATED', 'POLL', { pollId: poll.id, title, creatorId, optionCount: options.length });
  return { pollId: poll.id, options: pollOptions };
}

/** Erstellt das Poll-Embed. */
export function createPollEmbed(
  title: string,
  description: string | null,
  options: PollOption[],
  pollType: string,
  endsAt: Date | null,
  votes: Record<string, number>,
  totalVotes: number,
): EmbedBuilder {
  const optionLines = options.map(opt => {
    const voteCount = votes[opt.id] || 0;
    const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
    const bar = percentBar(percentage, 14);
    return `${opt.emoji} **${opt.text}**\n┃ ${bar}  **${percentage}%** (${voteCount})`;
  });
  const embed = vEmbed(Colors.Poll)
    .setTitle(`📊  ${title}`)
    .setDescription(
      (description ? `> ${description}\n\n` : '') +
      `${Brand.divider}\n\n` + optionLines.join('\n\n') + `\n\n${Brand.divider}`,
    )
    .addFields(
      { name: '📋 Typ', value: pollType === 'ANONYMOUS' ? '🔒 Anonym' : '👁️ Öffentlich', inline: true },
      { name: '🗳️ Stimmen', value: `**${totalVotes}**`, inline: true },
    );
  if (endsAt) embed.addFields({ name: '⏰ Endet', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true });
  embed.setFooter({ text: `${Brand.footerText} ${Brand.dot} Reagiere mit dem Emoji um abzustimmen` });
  return embed;
}

/**
 * Slash-Vote. Lesen, Limits, Insert und Counter-Synchronisierung sind atomar.
 */
export async function votePoll(
  pollId: string,
  userId: string,
  optionId: string,
  guildId: string,
): Promise<{ success: boolean; message: string }> {
  return withPollLock(pollId, async tx => {
    const poll = await tx.poll.findFirst({ where: { id: pollId, guildId } });
    const validation = validatePollForVote(poll, optionId);
    if (!validation.ok) return { success: false, message: validation.message };

    const existingVotes = await tx.pollVote.findMany({ where: { pollId, userId } });
    if (!poll!.allowMultiple && existingVotes.length > 0) {
      return { success: false, message: 'Du hast bereits abgestimmt. Mehrfachauswahl ist nicht erlaubt.' };
    }
    if (existingVotes.length >= poll!.maxChoices) {
      return { success: false, message: `Du hast die maximale Anzahl von ${poll!.maxChoices} Stimmen erreicht.` };
    }
    if (existingVotes.some(v => v.optionId === optionId)) {
      return { success: false, message: 'Du hast bereits fuer diese Option gestimmt.' };
    }

    await tx.pollVote.create({ data: { pollId, userId, optionId } });
    await syncVoteCounter(tx, pollId);
    return { success: true, message: 'Stimme erfolgreich abgegeben!' };
  });
}

/**
 * Kanonische Button-Toggle-Logik. Auch Remove und Single-Choice-Wechsel laufen
 * unter demselben Poll-Lock; der gespeicherte Counter wird danach aus den
 * echten PollVote-Zeilen neu gesetzt und kann weder negativ noch driftig sein.
 */
export async function togglePollVote(
  pollId: string,
  userId: string,
  optionId: string,
  guildId: string,
): Promise<PollToggleResult> {
  const result = await withPollLock(pollId, async tx => {
    const poll = await tx.poll.findFirst({ where: { id: pollId, guildId } });
    const validation = validatePollForVote(poll, optionId);
    if (!validation.ok) return { success: false, message: validation.message, action: 'NONE' as const };

    const existingVotes = await tx.pollVote.findMany({ where: { pollId, userId } });
    const sameOption = existingVotes.find(v => v.optionId === optionId);
    if (sameOption) {
      await tx.pollVote.delete({ where: { id: sameOption.id } });
      await syncVoteCounter(tx, pollId);
      return { success: true, message: 'Deine Stimme wurde zurueckgezogen.', action: 'REMOVED' as const };
    }

    if (poll!.allowMultiple) {
      if (existingVotes.length >= poll!.maxChoices) {
        return {
          success: false,
          message: `Du hast die maximale Anzahl von ${poll!.maxChoices} Stimmen erreicht.`,
          action: 'NONE' as const,
        };
      }
    } else if (existingVotes.length > 0) {
      // Single Choice: ein Button-Klick wechselt atomar von der alten auf die
      // neue Option, statt erst separat zu loeschen und dann erneut zu voten.
      await tx.pollVote.deleteMany({ where: { pollId, userId } });
    }

    await tx.pollVote.create({ data: { pollId, userId, optionId } });
    await syncVoteCounter(tx, pollId);
    return { success: true, message: 'Stimme abgegeben!', action: 'ADDED' as const };
  });

  if (result.success && result.action !== 'NONE') {
    logAudit(result.action === 'ADDED' ? 'POLL_VOTE_ADDED' : 'POLL_VOTE_REMOVED', 'POLL', {
      pollId, userId, optionId, guildId,
    });
  }
  return result;
}

/**
 * Beendet eine Umfrage. `beforeFinalize` darf die kritische Discord-Ausgabe
 * ausfuehren; bei Fehler rollt die Transaktion zurueck und der Poll bleibt
 * ACTIVE. Der gleiche Lock serialisiert Votes und Finalisierung.
 */
export async function endPoll(
  pollId: string,
  guildId: string,
  beforeFinalize?: (result: PollEndResult) => Promise<void>,
): Promise<PollEndResult> {
  const result = await withPollLock(pollId, async tx => {
    const poll = await tx.poll.findFirst({ where: { id: pollId, guildId }, include: { votes: true } });
    if (!poll) throw new Error('Umfrage nicht gefunden.');
    if (poll.status !== 'ACTIVE') throw new Error('Umfrage ist bereits beendet.');

    const options = poll.options as unknown as PollOption[];
    const voteCounts: Record<string, number> = {};
    for (const opt of options) voteCounts[opt.id] = 0;
    for (const vote of poll.votes) voteCounts[vote.optionId] = (voteCounts[vote.optionId] || 0) + 1;

    const total = poll.votes.length;
    const results = options.map(opt => ({
      option: opt.text,
      votes: voteCounts[opt.id],
      percentage: total > 0 ? Math.round((voteCounts[opt.id] / total) * 100) : 0,
    }));
    results.sort((a, b) => b.votes - a.votes);
    const winner = results[0]?.option || 'Keine Stimmen';
    const endResult: PollEndResult = { title: poll.title, results, totalVotes: total, winner };

    if (beforeFinalize) await beforeFinalize(endResult);
    await tx.poll.update({
      where: { id: pollId },
      data: { status: 'ENDED', results: results as unknown as any, totalVotes: total },
    });
    return endResult;
  });

  logAudit('POLL_ENDED', 'POLL', { pollId, totalVotes: result.totalVotes, winner: result.winner });
  return result;
}

export async function getPollVotes(pollId: string): Promise<Record<string, number>> {
  const votes = await prisma.pollVote.groupBy({
    by: ['optionId'], where: { pollId }, _count: { id: true },
  });
  const result: Record<string, number> = {};
  for (const v of votes) result[v.optionId] = v._count.id;
  return result;
}

/** Scheduler: Beendet abgelaufene Umfragen automatisch. */
export function startPollScheduler(client: Client): void {
  if (pollSchedulerTimer) return;
  pollSchedulerTimer = setInterval(async () => {
    try {
      const shardGuildIds = [...client.guilds.cache.keys()];
      const expiredPolls = await prisma.poll.findMany({
        where: { status: 'ACTIVE', endsAt: { lte: new Date() }, guildId: { in: shardGuildIds } },
      });

      for (const poll of expiredPolls) {
        if (!poll.guildId) {
          logger.warn('Poll-Scheduler: Poll ohne guildId wird aus Sicherheitsgruenden uebersprungen', { pollId: poll.id });
          continue;
        }
        try {
          await endPoll(poll.id, poll.guildId, async result => {
            const fetched = await client.channels.fetch(poll.channelId);
            if (!fetched || !fetched.isTextBased()) throw new Error('Poll-Channel ist nicht erreichbar oder nicht textbasiert.');
            const channel = fetched as TextChannel;
            const resultLines = result.results.map((r, i) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
              const bar = percentBar(r.percentage, 10);
              return `${medal} **${r.option}**\n┃ ${bar}  **${r.percentage}%** (${r.votes} Stimmen)`;
            });
            const embed = vEmbed(Colors.Success)
              .setTitle(`📊  Umfrage beendet: ${result.title}`)
              .setDescription(`${Brand.divider}\n\n${resultLines.join('\n\n')}\n\n${Brand.divider}`)
              .addFields(
                { name: '🏆 Gewinner', value: `**${result.winner}**`, inline: true },
                { name: '🗳️ Stimmen', value: `**${result.totalVotes}**`, inline: true },
              );
            const mentionContent = poll.notifyRoleId
              ? `<@&${poll.notifyRoleId}> 📊 Umfrage **${result.title}** wurde beendet!`
              : undefined;
            const sent = await safeSend(channel, {
              content: mentionContent,
              embeds: [embed],
              allowedMentions: { roles: poll.notifyRoleId ? [poll.notifyRoleId] : [], parse: [] },
            });
            if (!sent) throw new Error('Poll-Ergebnis konnte nicht in Discord zugestellt werden.');

            if (poll.messageId) {
              try {
                const msg = await channel.messages.fetch(poll.messageId);
                await msg.edit({ embeds: [embed], components: [] });
              } catch (error) {
                logger.debug('Poll-Scheduler: Originalnachricht konnte nicht aktualisiert werden', { pollId: poll.id, error });
              }
            }
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'Umfrage ist bereits beendet.') continue;
          logger.error('Poll-Scheduler: Fehler beim Beenden einer Umfrage', { pollId: poll.id, error });
        }
      }
    } catch (error) {
      logger.error('Poll-Scheduler: Allgemeiner Fehler', { error });
    }
  }, 5_000);
  pollSchedulerTimer.unref?.();
}

export function stopPollScheduler(): void {
  if (!pollSchedulerTimer) return;
  clearInterval(pollSchedulerTimer);
  pollSchedulerTimer = null;
}
