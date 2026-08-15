import type { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { logAudit, logger } from '../../utils/logger';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { Colors, Brand, vEmbed, percentBar } from '../../utils/embedDesign';
import { safeSend } from '../../utils/safeSend';

let pollSchedulerTimer: NodeJS.Timeout | null = null;

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

export interface PollEndResult {
  title: string;
  results: { option: string; votes: number; percentage: number }[];
  totalVotes: number;
  winner: string;
}

export const DEFAULT_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/**
 * Serialisiert alle zustandsveraendernden Operationen pro Poll direkt in
 * PostgreSQL. Damit greifen mehrere Bot-Instanzen/Worker fuer denselben Poll
 * nicht gleichzeitig auf Vote-Limits oder den Endzustand zu.
 *
 * Der Lock ist transaktionsgebunden und wird bei Commit, Rollback oder einem
 * abgebrochenen Prozess automatisch von PostgreSQL freigegeben.
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

/**
 * Erstellt eine neue Umfrage.
 */
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
      creatorId,
      channelId,
      guildId,
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
 * Stimme fuer eine Option ab.
 *
 * Poll-Lesen, Limitpruefung, Vote-Insert und Counter-Inkrement laufen unter
 * demselben PostgreSQL Advisory Transaction Lock. Dadurch koennen zwei
 * parallele Requests weder `allowMultiple=false` noch `maxChoices` umgehen
 * und Vote + totalVotes koennen nicht mehr auseinanderlaufen.
 */
export async function votePoll(
  pollId: string,
  userId: string,
  optionId: string,
  guildId: string,
): Promise<{ success: boolean; message: string }> {
  return withPollLock(pollId, async tx => {
    // Guild-Scoping (strikt): Stimmen koennen ausschliesslich fuer Polls der
    // eigenen Guild abgegeben werden. Kein Fallback auf globale Suche.
    const poll = await tx.poll.findFirst({
      where: { id: pollId, guildId },
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

    // Pruefe ob Option existiert.
    const options = poll.options as unknown as PollOption[];
    if (!options.find(o => o.id === optionId)) {
      return { success: false, message: 'Ungueltige Option.' };
    }

    // Bisherige Stimmen werden INNERHALB desselben Locks gelesen.
    const existingVotes = await tx.pollVote.findMany({
      where: { pollId, userId },
    });

    if (!poll.allowMultiple && existingVotes.length > 0) {
      return { success: false, message: 'Du hast bereits abgestimmt. Mehrfachauswahl ist nicht erlaubt.' };
    }

    if (existingVotes.length >= poll.maxChoices) {
      return { success: false, message: `Du hast die maximale Anzahl von ${poll.maxChoices} Stimmen erreicht.` };
    }

    if (existingVotes.some(v => v.optionId === optionId)) {
      return { success: false, message: 'Du hast bereits fuer diese Option gestimmt.' };
    }

    await tx.pollVote.create({
      data: { pollId, userId, optionId },
    });

    await tx.poll.update({
      where: { id: pollId },
      data: { totalVotes: { increment: 1 } },
    });

    return { success: true, message: 'Stimme erfolgreich abgegeben!' };
  });
}

/**
 * Beendet eine Umfrage und berechnet Ergebnisse.
 *
 * Optional kann `beforeFinalize` die notwendige Discord-Ausgabe ausfuehren.
 * Der Poll bleibt dabei bis zum erfolgreichen Abschluss ACTIVE und der gesamte
 * Ablauf ist pro Poll DB-seitig serialisiert. Wirft die Ausgabe einen Fehler,
 * rollt die Transaktion zurueck und der Scheduler kann spaeter erneut zustellen.
 */
export async function endPoll(
  pollId: string,
  guildId: string,
  beforeFinalize?: (result: PollEndResult) => Promise<void>,
): Promise<PollEndResult> {
  const result = await withPollLock(pollId, async tx => {
    const poll = await tx.poll.findFirst({
      where: { id: pollId, guildId },
      include: { votes: true },
    });

    if (!poll) throw new Error('Umfrage nicht gefunden.');
    if (poll.status !== 'ACTIVE') throw new Error('Umfrage ist bereits beendet.');

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

    results.sort((a, b) => b.votes - a.votes);
    const winner = results[0]?.option || 'Keine Stimmen';
    const endResult: PollEndResult = { title: poll.title, results, totalVotes: total, winner };

    // Kritische externe Ausgabe zuerst. Bei Fehler: Throw -> DB-Rollback ->
    // Poll bleibt ACTIVE und kann durch Scheduler/manuell erneut beendet werden.
    if (beforeFinalize) await beforeFinalize(endResult);

    await tx.poll.update({
      where: { id: pollId },
      data: {
        status: 'ENDED',
        results: results as unknown as any,
        totalVotes: total,
      },
    });

    return endResult;
  });

  // Audit erst NACH erfolgreichem Commit schreiben, damit kein END-Audit fuer
  // einen zurueckgerollten Poll entsteht.
  logAudit('POLL_ENDED', 'POLL', {
    pollId,
    totalVotes: result.totalVotes,
    winner: result.winner,
  });

  return result;
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
  if (pollSchedulerTimer) return;
  pollSchedulerTimer = setInterval(async () => {
    try {
      const shardGuildIds = [...client.guilds.cache.keys()];
      const expiredPolls = await prisma.poll.findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { lte: new Date() },
          guildId: { in: shardGuildIds },
        },
      });

      for (const poll of expiredPolls) {
        if (!poll.guildId) {
          logger.warn('Poll-Scheduler: Poll ohne guildId wird aus Sicherheitsgruenden uebersprungen', { pollId: poll.id });
          continue;
        }

        try {
          await endPoll(poll.id, poll.guildId, async result => {
            const fetched = await client.channels.fetch(poll.channelId);
            if (!fetched || !fetched.isTextBased()) {
              throw new Error('Poll-Channel ist nicht erreichbar oder nicht textbasiert.');
            }
            const channel = fetched as TextChannel;

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

            const mentionContent = poll.notifyRoleId
              ? `<@&${poll.notifyRoleId}> 📊 Umfrage **${result.title}** wurde beendet!`
              : undefined;

            // safeSend verschluckt Discord-Fehler absichtlich und liefert null.
            // Fuer die Poll-Finalisierung ist eine fehlgeschlagene Ausgabe aber
            // kritisch: null explizit in Throw umwandeln, damit DB rollbackt.
            const sent = await safeSend(channel, {
              content: mentionContent,
              embeds: [embed],
              allowedMentions: { roles: poll.notifyRoleId ? [poll.notifyRoleId] : [], parse: [] },
            });
            if (!sent) throw new Error('Poll-Ergebnis konnte nicht in Discord zugestellt werden.');

            // Originalnachricht ist nur eine UI-Spiegelung. Ist sie geloescht,
            // wurde das Ergebnis trotzdem erfolgreich im Channel publiziert.
            if (poll.messageId) {
              try {
                const msg = await channel.messages.fetch(poll.messageId);
                await msg.edit({ embeds: [embed], components: [] });
              } catch (error) {
                logger.debug('Poll-Scheduler: Originalnachricht konnte nicht aktualisiert werden', {
                  pollId: poll.id,
                  error,
                });
              }
            }
          });
        } catch (error) {
          // Ein anderer Worker/manueller Aufruf kann waehrend des Wartens auf
          // den Advisory Lock bereits erfolgreich finalisiert haben.
          if (error instanceof Error && error.message === 'Umfrage ist bereits beendet.') continue;
          logger.error('Poll-Scheduler: Fehler beim Beenden einer Umfrage', { pollId: poll.id, error });
        }
      }
    } catch (error) {
      logger.error('Poll-Scheduler: Allgemeiner Fehler', { error });
    }
  }, 5_000); // Alle 5 Sekunden pruefen
  pollSchedulerTimer.unref?.();
}

export function stopPollScheduler(): void {
  if (!pollSchedulerTimer) return;
  clearInterval(pollSchedulerTimer);
  pollSchedulerTimer = null;
}
