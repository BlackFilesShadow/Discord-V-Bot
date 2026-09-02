/**
 * Retrybare Discord-Zustellung fuer abgeschlossene Schwarzmarkt-Bestellungen.
 *
 * Der DB-Abschluss erzeugt atomar einen READY-Outbox-Datensatz. Diese Runtime
 * claimed ihn per Lease, aktualisiert das urspruengliche Pending-Embed, sendet
 * genau die Kundenmeldung und markiert sie erst danach SENT. Die gesendete
 * Ready-Meldung wird eine Stunde spaeter restart-sicher geloescht.
 */
import { ChannelType, EmbedBuilder, type Client, type TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { asGuildId, asNitradoConnId } from '../../types/scope';
import { logger, logAudit } from '../../utils/logger';
import { getMarketOrder, type MarketOrderView } from './blackMarketOrder';
import { getConfig } from './repository';

const POLL_INTERVAL_MS = 5_000;
const DELIVERY_BATCH = 25;
const CLEANUP_BATCH = 50;
const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 8;
const READY_DELETE_AFTER_MS = 60 * 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;

interface ReadyNotice {
  id: string;
  orderId: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  userDiscordId: string;
  attempts: number;
}

interface DueCleanupNotice {
  id: string;
  orderId: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  messageId: string | null;
}

function isUnknownDiscordResource(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = (error as { code?: unknown }).code;
  return value === code || value === String(code);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .slice(0, 1000);
}

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 15_000 * Math.pow(2, Math.max(0, attempt - 1)));
}

function itemLines(order: MarketOrderView): string {
  const lines = order.purchases.map(purchase => {
    const name = purchase.deliveryItems[0]?.itemText ?? purchase.listingId;
    return `• **${name}** × ${purchase.quantity} — ${purchase.amount.toLocaleString('de-DE')}`;
  });
  return (lines.join('\n') || 'Keine Artikeldetails verfügbar.').slice(0, 1024);
}

async function completedOrderEmbed(client: Client, order: MarketOrderView): Promise<EmbedBuilder> {
  const [cfg, vendor] = await Promise.all([
    getConfig(asGuildId(order.guildId), asNitradoConnId(order.nitradoConnId)),
    prisma.economyVirtualAccount.findFirst({
      where: { id: order.vendorAccountId, guildId: order.guildId, nitradoConnId: order.nitradoConnId },
      select: { name: true },
    }),
  ]);
  const guild = client.guilds.cache.get(order.guildId) ?? await client.guilds.fetch(order.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(order.userDiscordId).catch(() => null) : null;
  const username = member?.displayName ?? member?.user.username ?? order.userDiscordId;
  const createdUnix = Math.floor(order.createdAt.getTime() / 1000);
  const closedUnix = Math.floor((order.closedAt ?? new Date()).getTime() / 1000);

  return new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('✅ Bestellung abgeschlossen')
    .addFields(
      { name: 'Virtuelles Konto', value: (vendor?.name ?? 'Händler').slice(0, 1024), inline: true },
      { name: 'Username', value: username.slice(0, 1024), inline: true },
      { name: 'Status', value: '**Bestellung abgeschlossen**', inline: true },
      { name: 'Bestellt', value: `<t:${createdUnix}:f>`, inline: true },
      { name: 'Abgeschlossen', value: `<t:${closedUnix}:f>`, inline: true },
      { name: 'Gesamt', value: `**${order.totalAmount.toLocaleString('de-DE')} ${cfg.emoji}** (${cfg.currencyName})`, inline: true },
      { name: 'Artikel', value: itemLines(order), inline: false },
    )
    .setFooter({ text: 'V-Bot · Schwarzmarkt · Bestellung abgeschlossen' })
    .setTimestamp(order.closedAt ?? new Date());
}

async function editOriginalPendingMessage(client: Client, order: MarketOrderView): Promise<void> {
  if (!order.orderChannelId || !order.orderMessageId) return;
  const channel = await client.channels.fetch(order.orderChannelId).catch(error => {
    if (isUnknownDiscordResource(error, 10003)) return null;
    throw error;
  });
  if (!channel) return;
  if (channel.type !== ChannelType.GuildText || (channel as TextChannel).guildId !== order.guildId) {
    throw new Error('Urspruenglicher Bestellungs-Kanal ist nicht mehr gueltig.');
  }
  const message = await (channel as TextChannel).messages.fetch(order.orderMessageId).catch(error => {
    if (isUnknownDiscordResource(error, 10008)) return null;
    throw error;
  });
  if (!message) return;
  await message.edit({
    embeds: [await completedOrderEmbed(client, order)],
    components: [],
    allowedMentions: { parse: [] },
  });
}

async function readyChannel(client: Client, notice: ReadyNotice): Promise<TextChannel> {
  const channel = await client.channels.fetch(notice.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Bestellung-fertig-Kanal ist nicht erreichbar.');
  const text = channel as TextChannel;
  if (text.guildId !== notice.guildId) throw new Error('Bestellung-fertig-Kanal gehoert nicht zur erwarteten Guild.');
  return text;
}

async function markDeliveryFailed(notice: ReadyNotice, now: Date, error: unknown): Promise<void> {
  const attempts = notice.attempts + 1;
  const failed = attempts >= MAX_ATTEMPTS;
  await prisma.economyMarketOrderReadyNotice.updateMany({
    where: { id: notice.id, status: 'SENDING' },
    data: {
      status: failed ? 'FAILED' : 'READY',
      attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts)),
      leaseUntil: null,
      lastError: safeError(error),
    },
  });
}

async function deliverReadyNotice(notice: ReadyNotice, now: Date): Promise<void> {
  const claimed = await prisma.economyMarketOrderReadyNotice.updateMany({
    where: { id: notice.id, status: 'READY', nextAttemptAt: { lte: now } },
    data: { status: 'SENDING', leaseUntil: new Date(now.getTime() + LEASE_MS) },
  });
  if (claimed.count !== 1) return;

  try {
    const order = await getMarketOrder(asGuildId(notice.guildId), asNitradoConnId(notice.nitradoConnId), notice.orderId);
    if (!order || order.status !== 'CLOSED' || order.userDiscordId !== notice.userDiscordId) {
      throw new Error('Ready-Auftrag passt nicht mehr zur abgeschlossenen Bestellung.');
    }
    const client = tryGetDashboardClient();
    if (!client) throw new Error('Discord-Client nicht verfuegbar.');

    await editOriginalPendingMessage(client, order);
    const channel = await readyChannel(client, notice);
    const message = await channel.send({
      content: `<@${notice.userDiscordId}>`,
      embeds: [new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Bestellung fertig')
        .setDescription('Deine Bestellung ist fertig und kann abgeholt werden.')
        .addFields({ name: 'Status', value: '**Bestellung fertig**', inline: true })
        .setFooter({ text: 'V-Bot · Schwarzmarkt · automatische Löschung nach 1 Stunde' })
        .setTimestamp(now)],
      allowedMentions: { users: [notice.userDiscordId] },
      // Discord-seitige Deduplizierung fuer Crash/Retry nach erfolgreichem Send.
      nonce: notice.id.slice(0, 25),
      enforceNonce: true,
    });

    const marked = await prisma.economyMarketOrderReadyNotice.updateMany({
      where: { id: notice.id, status: 'SENDING' },
      data: {
        status: 'SENT',
        messageId: message.id,
        sentAt: now,
        deleteAt: new Date(now.getTime() + READY_DELETE_AFTER_MS),
        leaseUntil: null,
        lastError: null,
      },
    });
    if (marked.count !== 1) throw new Error('Ready-Auftrag konnte nach Discord-Versand nicht als SENT markiert werden.');

    logAudit('MARKET_ORDER_READY_NOTICE_SENT', 'ECONOMY', {
      guildId: notice.guildId,
      nitradoConnId: notice.nitradoConnId,
      orderId: notice.orderId,
      channelId: notice.channelId,
      messageId: message.id,
    });
  } catch (error) {
    await markDeliveryFailed(notice, now, error);
    logger.warn(`Schwarzmarkt-Ready-Zustellung fehlgeschlagen fuer ${notice.id}: ${safeError(error)}`);
  }
}

export async function runMarketOrderReadyDeliveryOnce(now = new Date()): Promise<void> {
  // Crash-Recovery fuer abgelaufene SENDING-Leases.
  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler ueber die eigene Ready-Outbox; jeder Auftrag bleibt scope-gebunden.
  await prisma.economyMarketOrderReadyNotice.updateMany({
    where: { status: 'SENDING', leaseUntil: { lt: now } },
    data: {
      status: 'READY',
      attempts: { increment: 1 },
      nextAttemptAt: now,
      leaseUntil: null,
      lastError: 'Ready notice lease expired; retry scheduled',
    },
  });

  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep; deliverReadyNotice revalidiert Order, Guild und Kanal.
  const due = await prisma.economyMarketOrderReadyNotice.findMany({
    where: { status: 'READY', nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: DELIVERY_BATCH,
    select: {
      id: true,
      orderId: true,
      guildId: true,
      nitradoConnId: true,
      channelId: true,
      userDiscordId: true,
      attempts: true,
    },
  });
  for (const notice of due) await deliverReadyNotice(notice, now);
}

async function deleteNoticeMessage(notice: DueCleanupNotice): Promise<void> {
  if (!notice.messageId) return;
  const client = tryGetDashboardClient();
  if (!client) throw new Error('Discord-Client nicht verfuegbar.');
  const channel = await client.channels.fetch(notice.channelId).catch(error => {
    if (isUnknownDiscordResource(error, 10003)) return null;
    throw error;
  });
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await (channel as TextChannel).messages.fetch(notice.messageId).catch(error => {
    if (isUnknownDiscordResource(error, 10008)) return null;
    throw error;
  });
  if (!message) return;
  await message.delete().catch(error => {
    if (!isUnknownDiscordResource(error, 10008)) throw error;
  });
}

export async function runMarketOrderReadyCleanupOnce(now = new Date()): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler-Sweep ueber SENT-Notices; Mutation bleibt auf Notice+Order+Scope eingeschraenkt.
  const due = await prisma.economyMarketOrderReadyNotice.findMany({
    where: { status: 'SENT', deletedAt: null, deleteAt: { not: null, lte: now } },
    orderBy: { deleteAt: 'asc' },
    take: CLEANUP_BATCH,
    select: { id: true, orderId: true, guildId: true, nitradoConnId: true, channelId: true, messageId: true },
  });
  for (const notice of due) {
    try {
      await deleteNoticeMessage(notice);
      await prisma.economyMarketOrderReadyNotice.updateMany({
        where: {
          id: notice.id,
          orderId: notice.orderId,
          guildId: notice.guildId,
          nitradoConnId: notice.nitradoConnId,
          status: 'SENT',
          deletedAt: null,
        },
        data: { deletedAt: now },
      });
    } catch (error) {
      logger.warn(`Schwarzmarkt-Bestellung-Ready-Cleanup fehlgeschlagen fuer ${notice.id}: ${safeError(error)}`);
    }
  }
}

export async function runMarketOrderReadyRuntimeOnce(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runMarketOrderReadyDeliveryOnce(now);
    await runMarketOrderReadyCleanupOnce(now);
  } catch (error) {
    logger.error('Schwarzmarkt-Bestellung-Ready-Runtime Fehler:', error as Error);
  } finally {
    running = false;
  }
}

export function startMarketOrderReadyRuntime(): void {
  if (timer) return;
  logger.info(`Schwarzmarkt-Bestellung-Ready-Runtime gestartet (Intervall ${POLL_INTERVAL_MS / 1000}s).`);
  timer = setInterval(() => { void runMarketOrderReadyRuntimeOnce(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void runMarketOrderReadyRuntimeOnce();
}

export function stopMarketOrderReadyRuntime(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
