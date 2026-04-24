import { Client, EmbedBuilder, TextChannel, User } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeSend, safeDm } from '../../utils/safeSend';

/**
 * Reminder-Scheduler.
 * Polled alle 30s reminders deren dueAt <= now ist und feuert sie ab.
 * Bei isRecurring wird dueAt = dueAt + recurrenceMs gesetzt, sonst isActive=false.
 */

const POLL_MS = 30_000;
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

async function fireReminder(client: Client, rem: {
  id: string; userId: string; channelId: string | null; message: string;
  isRecurring: boolean; recurrenceMs: number | null; fireCount: number; dueAt: Date;
}): Promise<void> {
  const embed = reminderEmbed(rem.message, rem.fireCount, rem.isRecurring);

  let delivered = false;
  try {
    if (rem.channelId) {
      const ch = await client.channels.fetch(rem.channelId).catch(() => null);
      if (ch && ch.isTextBased()) {
        await safeSend(ch as TextChannel, {
          content: `<@${rem.userId}>`,
          embeds: [embed],
          allowedMentions: { users: [rem.userId] },
        });
        delivered = true;
      }
    }
    if (!delivered) {
      const user: User | null = await client.users.fetch(rem.userId).catch(() => null);
      if (user) {
        await safeDm(user, { embeds: [embed] });
        delivered = true;
      }
    }
  } catch (e) {
    logger.warn(`Reminder ${rem.id}: Zustellung fehlgeschlagen.`, e as Error);
  }

  // DB-State updaten
  try {
    if (rem.isRecurring && rem.recurrenceMs && rem.recurrenceMs > 0) {
      const next = new Date(Math.max(Date.now() + 1000, rem.dueAt.getTime() + rem.recurrenceMs));
      await prisma.reminder.update({
        where: { id: rem.id },
        data: { dueAt: next, fireCount: { increment: 1 } },
      });
    } else {
      await prisma.reminder.update({
        where: { id: rem.id },
        data: { isActive: false, fireCount: { increment: 1 } },
      });
    }
  } catch (e) {
    logger.error(`Reminder ${rem.id}: DB-Update fehlgeschlagen`, e as Error);
  }
}

async function tick(client: Client): Promise<void> {
  const now = new Date();
  let due;
  try {
    due = await prisma.reminder.findMany({
      where: { isActive: true, dueAt: { lte: now } },
      orderBy: { dueAt: 'asc' },
      take: MAX_PER_TICK,
    });
  } catch (e) {
    logger.warn('Reminder-Scheduler: DB-Query fehlgeschlagen', e as Error);
    return;
  }
  for (const r of due) {
    await fireReminder(client, {
      id: r.id,
      userId: r.userId,
      channelId: r.channelId,
      message: r.message,
      isRecurring: r.isRecurring,
      recurrenceMs: r.recurrenceMs,
      fireCount: r.fireCount,
      dueAt: r.dueAt,
    });
  }
}

export function startReminderScheduler(client: Client): void {
  if (timer) return;
  timer = setInterval(() => {
    void tick(client).catch((e) => logger.error('Reminder-Scheduler-Fehler:', e as Error));
  }, POLL_MS);
  logger.info(`Reminder-Scheduler: gestartet (alle ${POLL_MS / 1000}s).`);
}

export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
