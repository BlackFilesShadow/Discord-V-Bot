import prisma from '../../database/prisma';
import { logAudit } from '../../utils/logger';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Colors, Brand, vEmbed, percentBar } from '../../utils/embedDesign';

/**
 * Poll-System Modul (Sektion 10):
 * - Schnelle Umfragen und Abstimmungen per Command
 * - Anonyme oder öffentliche Votes, Mehrfachauswahl, Zeitlimit
 * - Ergebnisse als Live-Embed, mit Diagrammen und Statistiken
 * - Automatische Auswertung und Archivierung
 * - Integration in Community-Events, Giveaways, Moderation
 */

export interface PollOption {
  id: string;
  text: string;
  emoji: string;
}

export const DEFAULT_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * Erstellt eine neue Umfrage.
 */
export async function createPoll(
  creatorId: string,
  channelId: string,
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
      creatorId,
      channelId,
      title,
      description,
      options: pollOptions as unknown as any,
      pollType,
      allowMultiple,
      maxChoices,
      endsAt,
      notifyRoleId,
    },
  });

  logAudit('POLL_CREATED', 'POLL', {
    pollId: poll.id, title, creatorId, optionCount: options.length,
  });

  return { pollId: poll.id, options: pollOptions };
}

/**
 * Erstellt das Poll-Embed.
 */
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
      `${Brand.divider}\n\n` +
      optionLines.join('\n\n') +
      `\n\n${Brand.divider}`
    )
    .addFields(
      { name: '📋 Typ', value: pollType === 'ANONYMOUS' ? '🔒 Anonym' : '👁️ Öffentlich', inline: true },
      { name: '🗳️ Stimmen', value: `**${totalVotes}**`, inline: true },
    );

  if (endsAt) {
    embed.addFields({ name: '⏰ Endet', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true });
  }

  embed.setFooter({ text: `${Brand.footerText} ${Brand.dot} Reagiere mit dem Emoji um abzustimmen` });

  return embed;
}

/**
 * Stimme für eine Option ab.
 */
export async function votePoll(
  pollId: string,
  userId: string,
  optionId: string,
): Promise<{ success: boolean; message: string }> {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
  });

  if (!poll) {
    return { success: false, message: 'Umfrage nicht gefunden.' };
  }

  if (poll.status !== 'ACTIVE') {
    return { success: false, message: 'Umfrage ist nicht mehr aktiv.' };
  }

  if (poll.endsAt && poll.endsAt <= new Date()) {
    return { success: false, message: 'Umfrage ist abgelaufen.' };
  }

  // Prüfe ob Option existiert
  const options = poll.options as unknown as PollOption[];
  if (!options.find(o => o.id === optionId)) {
    return { success: false, message: 'Ungültige Option.' };
  }

  // Prüfe bisherige Stimmen
  const existingVotes = await prisma.pollVote.findMany({
    where: { pollId, userId },
  });

  // Prüfe Mehrfachauswahl
  if (!poll.allowMultiple && existingVotes.length > 0) {
    return { success: false, message: 'Du hast bereits abgestimmt. Mehrfachauswahl ist nicht erlaubt.' };
  }

  // Prüfe max Choices
  if (existingVotes.length >= poll.maxChoices) {
    return { success: false, message: `Du hast die maximale Anzahl von ${poll.maxChoices} Stimmen erreicht.` };
  }

  // Prüfe ob bereits für diese Option gestimmt
  const alreadyVoted = existingVotes.find((v: any) => v.optionId === optionId);
  if (alreadyVoted) {
    return { success: false, message: 'Du hast bereits für diese Option gestimmt.' };
  }

  await prisma.pollVote.create({
    data: { pollId, userId, optionId },
  });

  await prisma.poll.update({
    where: { id: pollId },
    data: { totalVotes: { increment: 1 } },
  });

  return { success: true, message: 'Stimme erfolgreich abgegeben!' };
}

/**
 * Beendet eine Umfrage und berechnet Ergebnisse.
 */
export async function endPoll(pollId: string): Promise<{
  title: string;
  results: { option: string; votes: number; percentage: number }[];
  totalVotes: number;
  winner: string;
}> {
  const poll = await prisma.poll.findUnique({
    where: { id: pollId },
    include: { votes: true },
  });

  if (!poll) throw new Error('Umfrage nicht gefunden.');

  const options = poll.options as unknown as PollOption[];
  const voteCounts: Record<string, number> = {};
  for (const opt of options) {
    voteCounts[opt.id] = 0;
  }
  for (const vote of poll.votes) {
    voteCounts[vote.optionId] = (voteCounts[vote.optionId] || 0) + 1;
  }

  const total = poll.votes.length;
  const results = options.map(opt => ({
    option: opt.text,
    votes: voteCounts[opt.id],
    percentage: total > 0 ? Math.round((voteCounts[opt.id] / total) * 100) : 0,
  }));

  // Gewinner ermitteln
  results.sort((a, b) => b.votes - a.votes);
  const winner = results[0]?.option || 'Keine Stimmen';

  await prisma.poll.update({
    where: { id: pollId },
    data: {
      status: 'ENDED',
      results: results as unknown as any,
      totalVotes: total,
    },
  });

  logAudit('POLL_ENDED', 'POLL', { pollId, totalVotes: total, winner });

  return { title: poll.title, results, totalVotes: total, winner };
}

/**
 * Holt die aktuellen Stimmen einer Umfrage.
 */
export async function getPollVotes(pollId: string): Promise<Record<string, number>> {
  const votes = await prisma.pollVote.groupBy({
    by: ['optionId'],
    where: { pollId },
    _count: { id: true },
  });

  const result: Record<string, number> = {};
  for (const v of votes) {
    result[v.optionId] = v._count.id;
  }
  return result;
}

/**
 * Scheduler: Beendet abgelaufene Umfragen automatisch.
 */
export function startPollScheduler(client: Client): void {
  setInterval(async () => {
    try {
      const expiredPolls = await prisma.poll.findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { lte: new Date() },
        },
      });

      for (const poll of expiredPolls) {
        try {
          const result = await endPoll(poll.id);

          // Ergebnis-Embed im Channel posten
          const channel = await client.channels.fetch(poll.channelId) as TextChannel;
          if (channel) {
            const resultLines = result.results.map((r, i) => {
              const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
              const bar = percentBar(r.percentage, 10);
              return `${medal} **${r.option}**\n┃ ${bar}  **${r.percentage}%** (${r.votes} Stimmen)`;
            });

            const embed = vEmbed(Colors.Success)
              .setTitle(`📊  Umfrage beendet: ${result.title}`)
              .setDescription(`${Brand.divider}\n\n` + resultLines.join('\n\n') + `\n\n${Brand.divider}`)
              .addFields(
                { name: '🏆 Gewinner', value: `**${result.winner}**`, inline: true },
                { name: '🗳️ Stimmen', value: `**${result.totalVotes}**`, inline: true },
              );

            // Rollen-Ping bei Beendigung (optional)
            const mentionContent = poll.notifyRoleId ? `<@&${poll.notifyRoleId}> 📊 Umfrage **${result.title}** wurde beendet!` : undefined;

            await channel.send({ content: mentionContent, embeds: [embed] });

            // Originalnachricht updaten falls vorhanden
            if (poll.messageId) {
              try {
                const msg = await channel.messages.fetch(poll.messageId);
                await msg.edit({ embeds: [embed] });
              } catch { /* Message possibly deleted */ }
            }
          }
        } catch (error) {
          // Fehler bei einzelner Umfrage nicht den Scheduler stoppen
        }
      }
    } catch (error) {
      // Scheduler-Fehler ignorieren
    }
  }, 30_000); // Alle 30 Sekunden prüfen
}
