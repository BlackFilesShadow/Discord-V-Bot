/**
 * Restart-sichere Ready-Outbox + Cleanup fuer Schwarzmarkt-Bestellungen.
 * PENDING/SENDING werden mit kurzer Lease verarbeitet; Fehler landen mit
 * Backoff wieder in PENDING. SENT-Nachrichten werden nach einer Stunde geloescht.
 */
import { ChannelType, EmbedBuilder } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';

const POLL_INTERVAL_MS = 5_000;
const BATCH = 50;
const LEASE_MS = 30_000;
const READY_TTL_MS = 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface ReadyNoticeRow {
  id: string;
  orderId: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string | null;
  userDiscordId: string;
  messageId: string | null;
  attempts: number;
}

function isUnknownDiscordResource(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = (error as { code?: unknown }).code;
  return value === code || value === String(code);
}

function retryAt(now: Date, attempts: number): Date {
  const seconds = Math.min(300, Math.max(5, 5 * (2 ** Math.min(6, attempts))));
  return new Date(now.getTime() + seconds * 1000);
}

async function claimReadyNotice(now: Date): Promise<ReadyNoticeRow | null> {
  return prisma.$transaction(async tx => {
    const rows = await tx.$queryRawUnsafe<ReadyNoticeRow[]>(
      `SELECT "id","orderId","guildId","nitradoConnId","channelId","userDiscordId","messageId","attempts"
       FROM "EconomyMarketOrderReadyNotice"
       WHERE "deletedAt" IS NULL
         AND ("status"='PENDING' OR ("status"='SENDING' AND ("leaseUntil" IS NULL OR "leaseUntil" <= $1)))
         AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= $1)
       ORDER BY COALESCE("nextAttemptAt","createdAt") ASC, "createdAt" ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`,
      now,
    );
    const row = rows[0];
    if (!row) return null;
    const leaseUntil = new Date(now.getTime() + LEASE_MS);
    await tx.$executeRawUnsafe(
      `UPDATE "EconomyMarketOrderReadyNotice"
       SET "status"='SENDING', "attempts"="attempts"+1, "leaseUntil"=$2, "lastError"=NULL
       WHERE "id"=$1`,
      row.id, leaseUntil,
    );
    return { ...row, attempts: row.attempts + 1 };
  });
}

async function sendReadyNotice(notice: ReadyNoticeRow, now: Date): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Discord-Client nicht verfuegbar.');
  const projection = await prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId } },
    select: { orderReadyChannelId: true },
  });
  if (!projection?.orderReadyChannelId) throw new Error('Bestellung-fertig-Kanal ist nicht konfiguriert.');
  const channel = await client.channels.fetch(projection.orderReadyChannelId);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Bestellung-fertig-Kanal ist nicht erreichbar.');

  // Falls ein vorheriger Versuch die Nachricht bereits gesendet, aber den DB-
  // Status noch nicht persistiert hat, wird eine bekannte messageId wiederverwendet.
  let messageId = notice.messageId;
  if (messageId) {
    const existing = await channel.messages.fetch(messageId).catch(error => {
      if (isUnknownDiscordResource(error, 10008)) return null;
      throw error;
    });
    if (!existing) messageId = null;
  }
  if (!messageId) {
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('✅ Bestellung fertig')
      .setDescription('Deine Bestellung ist fertig und kann abgeholt werden.')
      .addFields({ name: 'Status', value: '**Bestellung fertig**', inline: true })
      .setFooter({ text: 'V-Bot · Schwarzmarkt · automatische Löschung nach 1 Stunde' })
      .setTimestamp(now);
    const sent = await channel.send({
      content: `<@${notice.userDiscordId}>`,
      embeds: [embed],
      allowedMentions: { users: [notice.userDiscordId] },
    });
    messageId = sent.id;
  }

  const deleteAt = new Date(now.getTime() + READY_TTL_MS);
  await prisma.economyMarketOrderReadyNotice.updateMany({
    where: { id: notice.id, orderId: notice.orderId, status: 'SENDING' },
    data: {
      channelId: channel.id,
      messageId,
      status: 'SENT',
      sentAt: now,
      deleteAt,
      nextAttemptAt: null,
      leaseUntil: null,
      lastError: null,
    },
  });
}

async function releaseReadyNotice(notice: ReadyNoticeRow, now: Date, error: unknown): Promise<void> {
  await prisma.economyMarketOrderReadyNotice.updateMany({
    where: { id: notice.id, orderId: notice.orderId, status: 'SENDING' },
    data: {
      status: 'PENDING',
      nextAttemptAt: retryAt(now, notice.attempts),
      leaseUntil: null,
      lastError: (error as Error).message.slice(0, 500),
    },
  });
}

async function deleteNoticeMessage(notice: ReadyNoticeRow): Promise<void> {
  if (!notice.messageId || !notice.channelId) return;
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
    for (let i = 0; i < BATCH; i += 1) {
      const notice = await claimReadyNotice(now);
      if (!notice) break;
      try {
        await sendReadyNotice(notice, now);
      } catch (error) {
        await releaseReadyNotice(notice, now, error);
        logger.warn(`Schwarzmarkt-Bestellung-Ready-Send fehlgeschlagen fuer ${notice.id}: ${(error as Error).message}`);
      }
    }

    const due = await prisma.economyMarketOrderReadyNotice.findMany({
      where: { status: 'SENT', deletedAt: null, deleteAt: { lte: now } },
      orderBy: { deleteAt: 'asc' },
      take: BATCH,
      select: { id: true, orderId: true, guildId: true, nitradoConnId: true, channelId: true, userDiscordId: true, messageId: true, attempts: true },
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
    logger.error('Schwarzmarkt-Bestellung-Ready Runtime Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startMarketOrderReadyRuntime(): void {
  if (timer) return;
  logger.info(`Schwarzmarkt-Bestellung-Ready-Outbox gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runMarketOrderReadyCleanupOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runMarketOrderReadyCleanupOnce();
}

export function stopMarketOrderReadyRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
