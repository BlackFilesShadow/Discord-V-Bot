import type { Prisma } from '@prisma/client';
import { Client, EmbedBuilder, TextChannel, User } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeSend, safeDm } from '../../utils/safeSend';

/**
 * Reminder-Scheduler.
 * Polled alle 30s Reminder deren dueAt <= now ist und feuert sie ab.
 * Erfolgreiche wiederkehrende Reminder werden weitergeschoben, einmalige
 * deaktiviert. Fehlgeschlagene Zustellungen bleiben aktiv und werden mit
 * Backoff erneut versucht.
 */

const POLL_MS = 30_000;
const RETRY_MS = 60_000;
const MAX_PER_TICK = 50; // Schutz gegen Lawine

let timer: NodeJS.Timeout | null = null;

function reminderEmbed(message: string, fireCount: number, recurring: boolean): EmbedBuilder {
  return vEmbed(Colors.Info)
    .setTitle('⏰ Erinnerung')
    .setDescription(`${Brand.divider}\n${message}\n${Brand.divider}`)
    .setFooter({
      text: `${Brand.footerText} • Reminder${recurring ? ` (#${fireCount + 1}, wiederkehrend)` : ''}`,
    });
}

/**
 * DB-seitiger Lock pro Reminder. Mehrere Bot-Instanzen duerfen denselben
 * faelligen Reminder sehen, aber immer nur eine Instanz darf ihn zustellen und
 * danach den Zustand fortschreiben.
 */
async function withReminderLock<T>(
  reminderId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$queryRawUnsafe(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `reminder:${reminderId}`,
    );
    return work(tx);
  });
}

async function deliverReminder(client: Client, rem: {
  id: string;
  userId: string;
  channelId: string | null;
  message: string;
  isRecurring: boolean;
  fireCount: number;
}): Promise<boolean> {
  const embed = reminderEmbed(rem.message, rem.fireCount, rem.isRecurring);

  if (rem.channelId) {
    const ch = await client.channels.fetch(rem.channelId).catch(() => null);
    if (ch && ch.isTextBased()) {
      const sent = await safeSend(ch as TextChannel, {
        content: `<@${rem.userId}>`,
        embeds: [embed],
        allowedMentions: { users: [rem.userId], parse: [] },
      });
      if (sent) return true;
    }
  }

  // Channel nicht erreichbar/Send fehlgeschlagen -> DM als Fallback.
  const user: User | null = await client.users.fetch(rem.userId).catch(() => null);
  if (!user) return false;
  return Boolean(await safeDm(user, { embeds: [embed] }));
}

/**
 * Verarbeitet genau einen Reminder unter DB-Lock.
 *
 * Wichtig: Nach dem Lock wird der aktuelle DB-Zustand erneut gelesen. Damit
 * wird ein zweiter Worker, der denselben veralteten due-Eintrag aus seinem
 * vorherigen Query hat, nach dem ersten erfolgreichen Worker zum No-Op.
 */
export async function fireReminderById(client: Client, reminderId: string): Promise<void> {
  await withReminderLock(reminderId, async tx => {
    const rem = await tx.reminder.findUnique({ where: { id: reminderId } });
    const now = new Date();

    if (!rem || !rem.isActive || rem.dueAt > now) return;

    let delivered = false;
    try {
      delivered = await deliverReminder(client, {
        id: rem.id,
        userId: rem.userId,
        channelId: rem.channelId,
        message: rem.message,
        isRecurring: rem.isRecurring,
        fireCount: rem.fireCount,
      });
    } catch (error) {
      logger.warn(`Reminder ${rem.id}: Zustellung fehlgeschlagen.`, error as Error);
    }

    if (!delivered) {
      // safeSend/safeDm geben bei Discord-Fehlern null zurueck. Das ist KEIN
      // Erfolg: Reminder aktiv lassen und den naechsten Versuch bewusst
      // verschieben, statt ihn zu verlieren oder alle 30s sofort zu fluten.
      const retryAt = new Date(Date.now() + RETRY_MS);
      await tx.reminder.update({
        where: { id: rem.id },
        data: { dueAt: retryAt },
      });
      logger.warn(`Reminder ${rem.id}: nicht zugestellt, erneuter Versuch geplant.`, { retryAt });
      return;
    }

    if (rem.isRecurring && rem.recurrenceMs && rem.recurrenceMs > 0) {
      const next = new Date(Math.max(Date.now() + 1000, rem.dueAt.getTime() + rem.recurrenceMs));
      await tx.reminder.update({
        where: { id: rem.id },
        data: { dueAt: next, fireCount: { increment: 1 } },
      });
    } else {
      await tx.reminder.update({
        where: { id: rem.id },
        data: { isActive: false, fireCount: { increment: 1 } },
      });
    }
  });
}

export async function runReminderTickOnce(client: Client): Promise<void> {
  const now = new Date();
  let due: Array<{ id: string }>;
  try {
    due = await prisma.reminder.findMany({
      where: { isActive: true, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: MAX_PER_TICK,
      select: { id: true },
    });
  } catch (error) {
    logger.warn('Reminder-Scheduler: DB-Query fehlgeschlagen', error as Error);
    return;
  }

  for (const rem of due) {
    try {
      await fireReminderById(client, rem.id);
    } catch (error) {
      // DB-/Transaktionsfehler duerfen nicht den restlichen Batch stoppen. Der
      // Reminder bleibt unveraendert/faellig und wird im naechsten Tick erneut
      // aufgenommen.
      logger.error(`Reminder ${rem.id}: Verarbeitung fehlgeschlagen`, error as Error);
    }
  }
}

export function startReminderScheduler(client: Client): void {
  if (timer) return;
  timer = setInterval(() => {
    void runReminderTickOnce(client).catch((error) => logger.error('Reminder-Scheduler-Fehler:', error as Error));
  }, POLL_MS);
  timer.unref?.();
  logger.info(`Reminder-Scheduler: gestartet (alle ${POLL_MS / 1000}s).`);
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
