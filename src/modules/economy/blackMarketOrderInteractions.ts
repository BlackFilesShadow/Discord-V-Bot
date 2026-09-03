/**
 * Discord-Interaktionen fuer die Schwarzmarkt-Sammelbestellung (Katalog-weiter
 * "Bestellen"-Button) und deren Abschluss ueber das Kontoverwaltungs-Panel.
 *
 * Discord-Modals koennen keine Select-Menus enthalten; die Item-Auswahl laeuft
 * deshalb ueber ein Select-Menu direkt in der (ephemeren) Nachricht, nicht in
 * einem Modal. Da eine Bestaetigungs-Aktion bis zu 25 Angebots-IDs betreffen
 * kann und ein Button-customId auf 100 Zeichen begrenzt ist, wird die Auswahl
 * zwischen Select und Bestaetigen ueber ein kurzlebiges, prozesslokales Token
 * gehalten (reine UI-Zwischenablage vor der ersten Geldbuchung; ein
 * Bot-Neustart in diesem Fenster kostet den Nutzer nur einen erneuten Klick,
 * es wurde noch kein Geld abgebucht).
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  MessageFlags,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../types/scope';
import { logger } from '../../utils/logger';
import { vEmbed } from '../../utils/embedDesign';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { listMarketListings, type MarketListingView } from './blackMarket';
import { getConfig } from './repository';
import { createMarketOrder, closeMarketOrder, listOpenMarketOrders, attachMarketOrderMessage, scheduleMarketOrderReadyNotice } from './blackMarketOrder';
import { listManagedVirtualAccounts } from './virtualAccountFinance';
import { getVirtualAccountById } from './virtualAccounts';

const PAGE_SIZE = 25;
const PENDING_TTL_MS = 10 * 60_000;

interface PendingOrderDraft {
  guildId: string;
  connId: string;
  userDiscordId: string;
  listingIds: string[];
  createdAt: number;
}

const pendingOrders = new Map<string, PendingOrderDraft>();

function sweepPendingOrders(now: number): void {
  for (const [token, draft] of pendingOrders) {
    if (now - draft.createdAt > PENDING_TTL_MS) pendingOrders.delete(token);
  }
}

async function replyError(interaction: ButtonInteraction | StringSelectMenuInteraction, message: string): Promise<void> {
  const payload = {
    embeds: [vEmbed(0xe74c3c).setTitle('Bestellung abgelehnt').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] },
  } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

interface OrderButtonContextRow {
  guildId: string;
  nitradoConnId: string;
}

/** Bindet den Klick strikt an genau die verwaltete Bestellungs-Button-Nachricht. */
async function resolveOrderButtonContext(args: { channelId: string; messageId: string }): Promise<{ guildId: string; connId: string }> {
  const rows = await prisma.$queryRawUnsafe<OrderButtonContextRow[]>(
    `SELECT m."guildId", m."nitradoConnId"
     FROM "EconomyMarketDiscordMessage" m
     JOIN "EconomyMarketDiscordProjection" p
       ON p."id"=m."projectionId" AND p."guildId"=m."guildId" AND p."nitradoConnId"=m."nitradoConnId"
     WHERE m."kind"='ORDER_BUTTON' AND m."channelId"=$1 AND m."messageId"=$2
       AND p."directBuyEnabled"=TRUE AND p."orderChannelId" IS NOT NULL AND p."orderReadyChannelId" IS NOT NULL
     LIMIT 1`,
    args.channelId, args.messageId,
  );
  const row = rows[0];
  if (!row) throw new Error('Diese Bestell-Aktion ist veraltet oder Bestellungen sind nicht mehr aktiv.');
  return { guildId: row.guildId, connId: row.nitradoConnId };
}

function listingOptionLabel(listing: MarketListingView): string {
  return listing.name.slice(0, 100);
}

async function vendorName(guildId: string, connId: string, vendorAccountId: string): Promise<string> {
  const account = await getVirtualAccountById(asGuildId(guildId), asNitradoConnId(connId), vendorAccountId);
  return account?.name ?? 'Händler';
}

function buildSelectPage(listings: MarketListingView[], page: number, totalPages: number): StringSelectMenuBuilder {
  const pageItems = listings.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  return new StringSelectMenuBuilder()
    .setCustomId(`marketorder:select:${page}`)
    .setPlaceholder(totalPages > 1 ? `Angebote auswählen (Seite ${page + 1}/${totalPages})` : 'Angebote auswählen')
    .setMinValues(1)
    .setMaxValues(pageItems.length)
    .addOptions(pageItems.map(listing => ({
      label: listingOptionLabel(listing),
      value: listing.id,
      description: `${listing.price.toLocaleString('de-DE')} · ${listing.sku}`.slice(0, 100),
    })));
}

function buildPageComponents(listings: MarketListingView[], page: number, connId: string) {
  const totalPages = Math.max(1, Math.ceil(listings.length / PAGE_SIZE));
  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(buildSelectPage(listings, page, totalPages)),
  ];
  if (totalPages > 1) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`marketorder:page:${Math.max(0, page - 1)}:${connId}`).setLabel('◀ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
      new ButtonBuilder().setCustomId(`marketorder:page:${Math.min(totalPages - 1, page + 1)}:${connId}`).setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    ));
  }
  return rows;
}

async function openOrderMenu(interaction: ButtonInteraction, guildId: string, connId: string, page: number): Promise<void> {
  const listings = await listMarketListings(asGuildId(guildId), asNitradoConnId(connId), false);
  if (listings.length === 0) {
    await replyError(interaction, 'Aktuell sind keine aktiven Angebote vorhanden.');
    return;
  }
  const totalPages = Math.max(1, Math.ceil(listings.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(totalPages - 1, page));
  const embed = vEmbed(0x22c55e)
    .setTitle('🛒 Bestellung aufgeben')
    .setDescription('Wähle unten alle gewünschten Angebote aus. Eine Bestellung kann nur Angebote **desselben Händlers** enthalten.');
  const components = buildPageComponents(listings, safePage, connId);
  if (interaction.replied || interaction.deferred) await interaction.editReply({ embeds: [embed], components });
  else await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
}

export async function handleMarketOrderButton(interaction: ButtonInteraction): Promise<void> {
  try {
    if (!interaction.channelId) throw new Error('Bestellungen sind nur in einem Discord-Server möglich.');
    const context = await resolveOrderButtonContext({ channelId: interaction.channelId, messageId: interaction.message.id });
    await openOrderMenu(interaction, context.guildId, context.connId, 0);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderPageButton(interaction: ButtonInteraction): Promise<void> {
  try {
    if (!interaction.guildId) throw new Error('Bestellungen sind nur in einem Discord-Server möglich.');
    const parts = interaction.customId.split(':');
    const page = Number(parts[2] ?? '0');
    const connId = parts[3];
    if (!connId) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut über „Bestellen" öffnen.');
    await openOrderMenu(interaction, interaction.guildId, connId, Number.isFinite(page) ? page : 0);
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try {
    if (!interaction.guildId) throw new Error('Bestellungen sind nur in einem Discord-Server möglich.');
    // Die ephemere Auswahl-Nachricht ist an keinen konkreten Kanal-Scope mehr
    // gebunden; Angebote werden deshalb direkt anhand der gewaehlten IDs gelesen
    // und serverseitig in createMarketOrder erneut vollstaendig validiert.
    const listingIds = [...new Set(interaction.values)];
    const rows = await prisma.economyMarketListing.findMany({
      where: { id: { in: listingIds }, guildId: interaction.guildId, active: true, archivedAt: null },
      select: { id: true, guildId: true, nitradoConnId: true, vendorAccountId: true, name: true, price: true },
    });
    if (rows.length !== listingIds.length) throw new Error('Mindestens ein Angebot ist nicht mehr verfügbar. Bitte die Auswahl erneut öffnen.');
    const guildId = rows[0].guildId;
    const connId = rows[0].nitradoConnId;
    const vendorAccountId = rows[0].vendorAccountId;
    if (rows.some(row => row.vendorAccountId !== vendorAccountId)) {
      throw new Error('Eine Bestellung kann nur Angebote desselben Händlers enthalten. Bitte pro Bestellung nur einen Händler auswählen.');
    }
    const total = rows.reduce((sum, row) => sum + row.price, 0n);
    const cfg = await getConfig(asGuildId(guildId), asNitradoConnId(connId));

    sweepPendingOrders(Date.now());
    const token = randomUUID().replace(/-/g, '').slice(0, 20);
    pendingOrders.set(token, {
      guildId, connId, userDiscordId: interaction.user.id, listingIds: rows.map(row => row.id), createdAt: Date.now(),
    });

    const vendor = await vendorName(guildId, connId, vendorAccountId);
    const embed = vEmbed(0x22c55e)
      .setTitle('🛒 Bestellung bestätigen')
      .setDescription(rows.map(row => `• ${row.name} — **${row.price.toLocaleString('de-DE')} ${cfg.emoji}**`).join('\n'))
      .addFields(
        { name: 'Händler', value: vendor, inline: true },
        { name: 'Gesamtsumme', value: `**${total.toLocaleString('de-DE')} ${cfg.emoji}**`, inline: true },
      )
      .setFooter({ text: 'Wird ausschließlich aus deinem Wallet bezahlt.' });
    await interaction.update({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`marketorder:confirm:${token}`).setLabel('Bestellung bestätigen').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`marketorder:cancel:${token}`).setLabel('Abbrechen').setStyle(ButtonStyle.Secondary),
      )],
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderCancelButton(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(':')[2];
  pendingOrders.delete(token);
  await interaction.update({
    embeds: [vEmbed(0x6b7280).setTitle('Bestellung abgebrochen').setDescription('Es wurde nichts bezahlt.')],
    components: [],
  });
}

async function postOrderChannelEmbed(guildId: string, connId: string, orderId: string, vendorName_: string, total: bigint, currencyEmoji: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  const projection = await prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    select: { orderChannelId: true },
  });
  if (!projection?.orderChannelId) return;
  const channel = await client.channels.fetch(projection.orderChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = vEmbed(0xf59e0b)
    .setTitle('📦 Bestellung')
    .addFields(
      { name: 'Händler', value: vendorName_, inline: true },
      { name: 'Summe', value: `**${total.toLocaleString('de-DE')} ${currencyEmoji}**`, inline: true },
    )
    .setFooter({ text: 'V-Bot · Schwarzmarkt · Bestellung offen' })
    .setTimestamp();
  const message = await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  await attachMarketOrderMessage({ guildId: asGuildId(guildId), nitradoConnId: asNitradoConnId(connId), orderId, channelId: channel.id, messageId: message.id });
}

export async function handleMarketOrderConfirmButton(interaction: ButtonInteraction): Promise<void> {
  const token = interaction.customId.split(':')[2];
  const draft = pendingOrders.get(token);
  if (!draft || draft.userDiscordId !== interaction.user.id || Date.now() - draft.createdAt > PENDING_TTL_MS) {
    pendingOrders.delete(token);
    await interaction.update({ embeds: [vEmbed(0xe74c3c).setTitle('Bestellung abgelaufen').setDescription('Bitte über „Bestellen" erneut öffnen.')], components: [] });
    return;
  }
  pendingOrders.delete(token);
  try {
    await interaction.deferUpdate();
    const cfg = await getConfig(asGuildId(draft.guildId), asNitradoConnId(draft.connId));
    const result = await createMarketOrder({
      guildId: asGuildId(draft.guildId),
      nitradoConnId: asNitradoConnId(draft.connId),
      userDiscordId: asUserDiscordId(draft.userDiscordId),
      listingIds: draft.listingIds,
      idempotencyKey: token,
    });
    const vendor = await vendorName(draft.guildId, draft.connId, result.order.vendorAccountId);
    await postOrderChannelEmbed(draft.guildId, draft.connId, result.order.id, vendor, result.order.totalAmount, cfg.emoji);
    await interaction.editReply({
      embeds: [vEmbed(0x22c55e).setTitle('Bestellung aufgegeben').setDescription(`**${result.order.totalAmount.toLocaleString('de-DE')} ${cfg.emoji}** wurden aus deinem Wallet abgebucht. Du wirst benachrichtigt, sobald die Bestellung bereit ist.`)],
      components: [],
    });
  } catch (error) {
    logger.warn(`Schwarzmarkt-Bestellung fehlgeschlagen: ${(error as Error).message}`);
    await interaction.editReply({
      embeds: [vEmbed(0xe74c3c).setTitle('Bestellung fehlgeschlagen').setDescription((error as Error).message)],
      components: [],
    }).catch(() => undefined);
  }
}

export async function handleMarketOrderManagerButton(interaction: ButtonInteraction): Promise<void> {
  const connId = interaction.customId.split(':')[2];
  try {
    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');
    const guildId = asGuildId(interaction.guildId);
    const nitradoConnId = asNitradoConnId(connId);
    const accounts = (await listManagedVirtualAccounts(guildId, nitradoConnId, asUserDiscordId(interaction.user.id)))
      .filter(account => account.kind === 'MARKET_VENDOR');
    if (accounts.length === 0) throw new Error('Dir ist kein Schwarzmarkt-Händlerkonto zugewiesen.');
    const open = (await Promise.all(accounts.map(account => listOpenMarketOrders(guildId, nitradoConnId, account.id)))).flat();
    if (open.length === 0) throw new Error('Aktuell sind keine offenen Bestellungen vorhanden.');
    const guild = interaction.guild;
    const options = await Promise.all(open.slice(0, 25).map(async order => {
      const member = guild ? guild.members.cache.get(order.userDiscordId) ?? await guild.members.fetch(order.userDiscordId).catch(() => null) : null;
      const label = `${member?.displayName ?? member?.user.username ?? order.userDiscordId} · ${order.purchases.length} Artikel · ${order.totalAmount.toLocaleString('de-DE')}`;
      const items = order.purchases.flatMap(purchase => purchase.deliveryItems.map(item => item.itemText)).filter(Boolean).join(', ');
      return { label: label.slice(0, 100), value: order.id, description: items ? items.slice(0, 100) : undefined };
    }));
    const select = new StringSelectMenuBuilder()
      .setCustomId(`vacct_mgr_order_sel:${connId}`)
      .setPlaceholder('Bestellung zum Abschließen auswählen')
      .addOptions(options);
    await interaction.reply({
      embeds: [vEmbed(0x5865f2).setTitle('Bestellung abschließen').setDescription('Wähle die abzuschließende Bestellung. Der Kunde wird im Bestellung-bereit-Kanal benachrichtigt.')],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

async function postOrderReadyEmbed(guildId: string, connId: string, orderId: string, userDiscordId: string): Promise<void> {
  const client = tryGetDashboardClient();
  if (!client) return;
  const projection = await prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    select: { orderReadyChannelId: true },
  });
  if (!projection?.orderReadyChannelId) return;
  const channel = await client.channels.fetch(projection.orderReadyChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const embed = vEmbed(0x22c55e)
    .setTitle('✅ Bestellung abgeschlossen')
    .setDescription('Status: **Bestellung bereit**')
    .setFooter({ text: 'V-Bot · Schwarzmarkt' })
    .setTimestamp();
  const message = await (channel as TextChannel).send({
    content: `<@${userDiscordId}>`,
    embeds: [embed],
    allowedMentions: { users: [userDiscordId] },
  });
  await scheduleMarketOrderReadyNotice({
    guildId: asGuildId(guildId), nitradoConnId: asNitradoConnId(connId), orderId,
    channelId: channel.id, userDiscordId: asUserDiscordId(userDiscordId), messageId: message.id,
  });
}

export async function handleMarketOrderManagerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const connId = interaction.customId.split(':')[2];
  const orderId = interaction.values[0];
  try {
    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');
    const guildId = asGuildId(interaction.guildId);
    const nitradoConnId = asNitradoConnId(connId);
    const accounts = (await listManagedVirtualAccounts(guildId, nitradoConnId, asUserDiscordId(interaction.user.id)))
      .filter(account => account.kind === 'MARKET_VENDOR');
    const orderRows = (await Promise.all(accounts.map(account => listOpenMarketOrders(guildId, nitradoConnId, account.id)))).flat();
    const order = orderRows.find(row => row.id === orderId);
    if (!order) throw new Error('Bestellung ist nicht mehr offen oder dir nicht zugewiesen.');

    await interaction.deferUpdate();
    const result = await closeMarketOrder({
      guildId, nitradoConnId, orderId, vendorAccountId: order.vendorAccountId, actorDiscordId: asUserDiscordId(interaction.user.id),
    });
    if (result.changed) await postOrderReadyEmbed(guildId, nitradoConnId, orderId, order.userDiscordId);
    await interaction.editReply({
      embeds: [vEmbed(0x22c55e).setTitle('Bestellung abgeschlossen').setDescription(`Bestellung von <@${order.userDiscordId}> wurde abgeschlossen und der Kunde benachrichtigt.`)],
      components: [],
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}
