/**
 * Garantierte Loeschung der Schwarzmarkt-"Bestellung bereit"-Mention nach 1
 * Minute. Persistentes Pendant zu `expiryRuntime.ts` (Server-Ban-Ablauf):
 * ein einfaches `setTimeout` waere bei einem Bot-Neustart innerhalb der
 * Minute verloren; dieser Cron liest stattdessen faellige Datensaetze aus
 * `EconomyMarketOrderReadyNotice` und loescht die Discord-Nachricht robust
 * nach.
 */
import { ChannelType } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';

const POLL_INTERVAL_MS = 5_000;
const BATCH = 50;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface DueNotice {
  id: string;
  channelId: string;
  messageId: string | null;
}

function isUnknownDiscordResource(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = (error as { code?: unknown }).code;
  return value === code || value === String(code);
}

async function deleteNoticeMessage(notice: DueNotice): Promise<void> {
  if (!notice.messageId) return;
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Discord-Client nicht verfuegbar.');
  const channel = await client.channels.fetch(notice.channelId).catch(error => {
    if (isUnknownDiscordResource(error, 10003)) return null;
    throw error;
  });
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(notice.messageId).catch(error => {
    if (isUnknownDiscordResource(error, 10008)) return null;
    throw error;
  });
  if (!message) return;
  await message.delete().catch(error => {
    if (!isUnknownDiscordResource(error, 10008)) throw error;
  });
}

export async function runMarketOrderReadyCleanupOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await prisma.economyMarketOrderReadyNotice.findMany({
      where: { deletedAt: null, deleteAt: { lte: now } },
      orderBy: { deleteAt: 'asc' },
      take: BATCH,
      select: { id: true, orderId: true, guildId: true, nitradoConnId: true, channelId: true, messageId: true },
    });
    for (const notice of due) {
      try {
        await deleteNoticeMessage(notice);
        await prisma.economyMarketOrderReadyNotice.updateMany({
          where: { id: notice.id, orderId: notice.orderId, guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, deletedAt: null },
          data: { deletedAt: now },
        });
      } catch (error) {
        logger.warn(`Schwarzmarkt-Bestellung-Ready-Cleanup fehlgeschlagen fuer ${notice.id}: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    logger.error('Schwarzmarkt-Bestellung-Ready-Cleanup Runtime Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startMarketOrderReadyRuntime(): void {
  if (timer) return;
  logger.info(`Schwarzmarkt-Bestellung-Ready-Cleanup gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runMarketOrderReadyCleanupOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runMarketOrderReadyCleanupOnce();
}

export function stopMarketOrderReadyRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
