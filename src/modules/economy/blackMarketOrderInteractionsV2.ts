import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../types/scope';
import { logger } from '../../utils/logger';
import { listMarketListings, type MarketListingView } from './blackMarket';
import { getConfig } from './repository';
import {
  attachMarketOrderMessage,
  closeMarketOrder,
  listOpenMarketOrders,
  type MarketOrderView,
} from './blackMarketOrder';
import {
  createMarketOrderV2,
  MAX_MARKET_ORDER_UNITS,
  scheduleMarketOrderReadyNoticeOneHour,
} from './blackMarketOrderV2';
import { listManagedVirtualAccounts } from './virtualAccountFinance';
import { getVirtualAccountById } from './virtualAccounts';

const PAGE_SIZE = 25;
const CART_TTL_MS = 15 * 60_000;

type ComponentInteraction = ButtonInteraction | StringSelectMenuInteraction;

interface CartDraft {
  guildId: string;
  connId: string;
  userDiscordId: string;
  lines: Record<string, number>;
  vendorAccountId: string | null;
  selectedListingId: string | null;
  selectedQuantity: number;
  page: number;
  createdAt: number;
}

const carts = new Map<string, CartDraft>();

function sweepCarts(now = Date.now()): void {
  for (const [token, draft] of carts) {
    if (now - draft.createdAt > CART_TTL_MS) carts.delete(token);
  }
}

function newToken(): string {
  return randomUUID().replace(/-/g, '').slice(0, 20);
}

function parseToken(customId: string, index = 2): string {
  const token = customId.split(':')[index];
  if (!token) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut über „Bestellen“ öffnen.');
  return token;
}

function getCartForUser(token: string, userDiscordId: string): CartDraft {
  sweepCarts();
  const draft = carts.get(token);
  if (!draft || draft.userDiscordId !== userDiscordId || Date.now() - draft.createdAt > CART_TTL_MS) {
    carts.delete(token);
    throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut über „Bestellen“ öffnen.');
  }
  return draft;
}

async function replyError(interaction: ComponentInteraction, message: string): Promise<void> {
  const payload = {
    embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Bestellung abgelehnt').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] },
  } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => undefined);
  else await interaction.reply(payload).catch(() => undefined);
}

interface OrderButtonContextRow {
  guildId: string;
  nitradoConnId: string;
}

async function resolveOrderButtonContext(args: { channelId: string; messageId: string }): Promise<{ guildId: string; connId: string }> {
  const rows = await prisma.$queryRawUnsafe<OrderButtonContextRow[]>(
    `SELECT m."guildId", m."nitradoConnId"
     FROM "EconomyMarketDiscordMessage" m
     JOIN "EconomyMarketDiscordProjection" p
       ON p."id"=m."projectionId" AND p."guildId"=m."guildId" AND p."nitradoConnId"=m."nitradoConnId"
     WHERE m."kind"='ORDER_BUTTON' AND m."channelId"=$1 AND m."messageId"=$2
       AND p."directBuyEnabled"=TRUE AND p."orderChannelId" IS NOT NULL AND p."orderReadyChannelId" IS NOT NULL
     LIMIT 1`,
    args.channelId,
    args.messageId,
  );
  const row = rows[0];
  if (!row) throw new Error('Diese Bestell-Aktion ist veraltet oder Bestellungen sind nicht mehr aktiv.');
  return { guildId: row.guildId, connId: row.nitradoConnId };
}

async function vendorName(guildId: string, connId: string, vendorAccountId: string): Promise<string> {
  const account = await getVirtualAccountById(asGuildId(guildId), asNitradoConnId(connId), vendorAccountId);
  return account?.name ?? 'Händler';
}

function totalUnits(draft: CartDraft): number {
  return Object.values(draft.lines).reduce((sum, quantity) => sum + quantity, 0);
}

function optionLabel(listing: MarketListingView): string {
  return listing.name.slice(0, 100);
}

async function cartPayload(token: string, draft: CartDraft) {
  const [allListings, cfg] = await Promise.all([
    listMarketListings(asGuildId(draft.guildId), asNitradoConnId(draft.connId), false),
    getConfig(asGuildId(draft.guildId), asNitradoConnId(draft.connId)),
  ]);
  const listings = draft.vendorAccountId
    ? allListings.filter(listing => listing.vendorAccountId === draft.vendorAccountId)
    : allListings;
  if (listings.length === 0) throw new Error('Aktuell sind keine aktiven Angebote vorhanden.');

  const totalPages = Math.max(1, Math.ceil(listings.length / PAGE_SIZE));
  draft.page = Math.max(0, Math.min(totalPages - 1, draft.page));
  const pageItems = listings.slice(draft.page * PAGE_SIZE, draft.page * PAGE_SIZE + PAGE_SIZE);
  const listingById = new Map(allListings.map(listing => [listing.id, listing]));

  const lines = Object.entries(draft.lines).flatMap(([listingId, quantity]) => {
    const listing = listingById.get(listingId);
    return listing ? [{ listing, quantity }] : [];
  });
  const total = lines.reduce((sum, line) => sum + line.listing.price * BigInt(line.quantity), 0n);
  const vendor = draft.vendorAccountId ? await vendorName(draft.guildId, draft.connId, draft.vendorAccountId) : null;

  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('🛒 Bestellung aufgeben')
    .setDescription(lines.length
      ? lines.map(line => `• **${line.listing.name}** × ${line.quantity} — ${((line.listing.price * BigInt(line.quantity))).toLocaleString('de-DE')} ${cfg.emoji}`).join('\n')
      : 'Wähle einen Artikel und eine Menge aus und füge ihn dem Warenkorb hinzu.')
    .addFields(
      { name: 'Virtuelles Konto', value: vendor ?? 'Noch nicht gewählt', inline: true },
      { name: 'Artikel im Warenkorb', value: `${totalUnits(draft)}/${MAX_MARKET_ORDER_UNITS}`, inline: true },
      { name: 'Gesamtsumme', value: `**${total.toLocaleString('de-DE')} ${cfg.emoji}**`, inline: true },
    )
    .setFooter({ text: 'Zahlung wahlweise aus Wallet oder Bank · maximal 20 Artikel je Bestellung' });

  const listingSelect = new StringSelectMenuBuilder()
    .setCustomId(`marketorder:item:${token}`)
    .setPlaceholder(totalPages > 1 ? `Artikel wählen · Seite ${draft.page + 1}/${totalPages}` : 'Artikel wählen')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(pageItems.map(listing => ({
      label: optionLabel(listing),
      value: listing.id,
      description: `${listing.price.toLocaleString('de-DE')} ${cfg.currencyName} · ${listing.sku}`.slice(0, 100),
      default: listing.id === draft.selectedListingId,
    })));

  const quantitySelect = new StringSelectMenuBuilder()
    .setCustomId(`marketorder:qty:${token}`)
    .setPlaceholder(`Menge wählen · aktuell ${draft.selectedQuantity}`)
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(Array.from({ length: MAX_MARKET_ORDER_UNITS }, (_, index) => {
      const quantity = index + 1;
      return { label: `${quantity} Stück`, value: String(quantity), default: quantity === draft.selectedQuantity };
    }));

  const rows: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(listingSelect),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(quantitySelect),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`marketorder:add:${token}`).setLabel('Zum Warenkorb').setEmoji('➕').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`marketorder:pay:w:${token}`).setLabel('Mit Wallet bezahlen').setEmoji('🛒').setStyle(ButtonStyle.Success).setDisabled(lines.length === 0),
      new ButtonBuilder().setCustomId(`marketorder:pay:b:${token}`).setLabel('Mit Bank bezahlen').setEmoji('🏦').setStyle(ButtonStyle.Primary).setDisabled(lines.length === 0),
    ),
  ];

  if (totalPages > 1) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`marketorder:page:${token}:${Math.max(0, draft.page - 1)}`).setLabel('◀ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(draft.page <= 0),
      new ButtonBuilder().setCustomId(`marketorder:page:${token}:${Math.min(totalPages - 1, draft.page + 1)}`).setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(draft.page >= totalPages - 1),
    ));
  }
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`marketorder:cancel:${token}`).setLabel('Abbrechen').setStyle(ButtonStyle.Danger),
  ));

  return { embeds: [embed], components: rows, allowedMentions: { parse: [] as never[] } };
}

export async function handleMarketOrderButton(interaction: ButtonInteraction): Promise<void> {
  try {
    if (!interaction.channelId) throw new Error('Bestellungen sind nur in einem Discord-Server möglich.');
    const context = await resolveOrderButtonContext({ channelId: interaction.channelId, messageId: interaction.message.id });
    const token = newToken();
    const draft: CartDraft = {
      guildId: context.guildId,
      connId: context.connId,
      userDiscordId: interaction.user.id,
      lines: {},
      vendorAccountId: null,
      selectedListingId: null,
      selectedQuantity: 1,
      page: 0,
      createdAt: Date.now(),
    };
    carts.set(token, draft);
    await interaction.reply({ ...(await cartPayload(token, draft)), flags: MessageFlags.Ephemeral });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderItemSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId);
    const draft = getCartForUser(token, interaction.user.id);
    draft.selectedListingId = interaction.values[0] ?? null;
    await interaction.update(await cartPayload(token, draft));
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderQuantitySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId);
    const draft = getCartForUser(token, interaction.user.id);
    const quantity = Number(interaction.values[0] ?? '1');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MARKET_ORDER_UNITS) throw new Error('Ungültige Bestellmenge.');
    draft.selectedQuantity = quantity;
    await interaction.update(await cartPayload(token, draft));
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderAddButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId);
    const draft = getCartForUser(token, interaction.user.id);
    if (!draft.selectedListingId) throw new Error('Bitte zuerst einen Artikel auswählen.');
    const listing = await prisma.economyMarketListing.findFirst({
      where: {
        id: draft.selectedListingId,
        guildId: draft.guildId,
        nitradoConnId: draft.connId,
        active: true,
        archivedAt: null,
      },
      select: { id: true, vendorAccountId: true, name: true },
    });
    if (!listing) throw new Error('Der ausgewählte Artikel ist nicht mehr verfügbar.');
    if (draft.vendorAccountId && draft.vendorAccountId !== listing.vendorAccountId) {
      throw new Error('Eine Bestellung kann nur Artikel desselben virtuellen Händlerkontos enthalten.');
    }
    const current = draft.lines[listing.id] ?? 0;
    const next = current + draft.selectedQuantity;
    if (next > MAX_MARKET_ORDER_UNITS) throw new Error(`Von ${listing.name} sind pro Bestellung maximal ${MAX_MARKET_ORDER_UNITS} Stück möglich.`);
    if (totalUnits(draft) + draft.selectedQuantity > MAX_MARKET_ORDER_UNITS) {
      throw new Error(`Eine Bestellung darf insgesamt maximal ${MAX_MARKET_ORDER_UNITS} Artikel enthalten.`);
    }
    draft.vendorAccountId = listing.vendorAccountId;
    draft.lines[listing.id] = next;
    draft.selectedListingId = null;
    draft.selectedQuantity = 1;
    draft.page = 0;
    await interaction.update(await cartPayload(token, draft));
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderPageButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const parts = interaction.customId.split(':');
    const token = parts[2];
    const page = Number(parts[3] ?? '0');
    if (!token) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut öffnen.');
    const draft = getCartForUser(token, interaction.user.id);
    draft.page = Number.isFinite(page) ? Math.max(0, page) : 0;
    draft.selectedListingId = null;
    await interaction.update(await cartPayload(token, draft));
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

export async function handleMarketOrderCancelButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId);
    const draft = getCartForUser(token, interaction.user.id);
    carts.delete(token);
    await interaction.update({
      embeds: [new EmbedBuilder().setColor(0x6b7280).setTitle('Bestellung abgebrochen').setDescription(`Der Warenkorb mit ${totalUnits(draft)} Artikel(n) wurde verworfen. Es wurde nichts bezahlt.`)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

function orderItemLines(order: MarketOrderView, names: Map<string, string>): string[] {
  return order.purchases.map(purchase => {
    const name = names.get(purchase.listingId) ?? purchase.deliveryItems[0]?.itemText ?? 'Artikel';
    return `• **${name}** × ${purchase.quantity} — ${purchase.amount.toLocaleString('de-DE')}`;
  });
}

async function postOrderChannelEmbed(client: Client, order: MarketOrderView, currencyName: string, currencyEmoji: string): Promise<void> {
  const projection = await prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId: order.guildId, nitradoConnId: order.nitradoConnId } },
    select: { orderChannelId: true },
  });
  if (!projection?.orderChannelId) throw new Error('Bestellungs-Kanal ist nicht konfiguriert.');
  const channel = await client.channels.fetch(projection.orderChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Bestellungs-Kanal ist nicht erreichbar.');

  const guild = client.guilds.cache.get(order.guildId) ?? await client.guilds.fetch(order.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(order.userDiscordId).catch(() => null) : null;
  const username = member?.displayName ?? member?.user.username ?? order.userDiscordId;
  const vendor = await vendorName(order.guildId, order.nitradoConnId, order.vendorAccountId);
  const listings = await prisma.economyMarketListing.findMany({
    where: { id: { in: order.purchases.map(purchase => purchase.listingId) }, guildId: order.guildId, nitradoConnId: order.nitradoConnId },
    select: { id: true, name: true },
  });
  const names = new Map(listings.map(listing => [listing.id, listing.name]));
  const lines = orderItemLines(order, names);
  const createdUnix = Math.floor(order.createdAt.getTime() / 1000);

  const embed = new EmbedBuilder()
    .setColor(0xf59e0b)
    .setTitle('📦 Bestellung ausstehend')
    .addFields(
      { name: 'Virtuelles Konto', value: vendor, inline: true },
      { name: 'Username', value: username.slice(0, 1024), inline: true },
      { name: 'Status', value: '**Bestellung ausstehend**', inline: true },
      { name: 'Datum', value: `<t:${createdUnix}:D>`, inline: true },
      { name: 'Uhrzeit', value: `<t:${createdUnix}:T>`, inline: true },
      { name: 'Gesamt', value: `**${order.totalAmount.toLocaleString('de-DE')} ${currencyEmoji}** (${currencyName})`, inline: true },
      { name: 'Artikel', value: lines.join('\n').slice(0, 1024), inline: false },
    )
    .setFooter({ text: 'V-Bot · Schwarzmarkt · Bestellung offen' })
    .setTimestamp(order.createdAt);

  const message = await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  await attachMarketOrderMessage({
    guildId: asGuildId(order.guildId),
    nitradoConnId: asNitradoConnId(order.nitradoConnId),
    orderId: order.id,
    channelId: channel.id,
    messageId: message.id,
  });
}

export async function handleMarketOrderPayButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const pocketCode = parts[2];
  const token = parts[3];
  try {
    if (!token) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut öffnen.');
    const draft = getCartForUser(token, interaction.user.id);
    const lines = Object.entries(draft.lines).map(([listingId, quantity]) => ({ listingId, quantity }));
    if (lines.length === 0) throw new Error('Der Warenkorb ist leer.');
    const sourcePocket = pocketCode === 'b' ? 'BANK' : pocketCode === 'w' ? 'WALLET' : null;
    if (!sourcePocket) throw new Error('Ungültige Zahlungsart.');

    await interaction.deferUpdate();
    const cfg = await getConfig(asGuildId(draft.guildId), asNitradoConnId(draft.connId));
    const result = await createMarketOrderV2({
      guildId: asGuildId(draft.guildId),
      nitradoConnId: asNitradoConnId(draft.connId),
      userDiscordId: asUserDiscordId(draft.userDiscordId),
      lines,
      sourcePocket,
      idempotencyKey: token,
    });
    carts.delete(token);

    let discordWarning: string | null = null;
    try {
      await postOrderChannelEmbed(interaction.client, result.order, cfg.currencyName, cfg.emoji);
    } catch (embedError) {
      discordWarning = ' Die Zahlung war erfolgreich und die Bestellung wurde gespeichert, aber das Bestell-Embed konnte nicht gesendet werden. Bitte einen Admin informieren.';
      logger.error(`Bestell-Embed fehlgeschlagen (${result.order.id}):`, embedError as Error);
    }

    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(discordWarning ? 0xf59e0b : 0x22c55e)
        .setTitle(discordWarning ? '⚠️ Bestellung bezahlt' : '✅ Bestellung aufgegeben')
        .setDescription(`**${result.order.totalAmount.toLocaleString('de-DE')} ${cfg.emoji}** wurden aus deiner **${sourcePocket === 'BANK' ? 'Bank' : 'Wallet'}** abgebucht.${discordWarning ?? ' Deine Bestellung steht nun auf **ausstehend**.'}`)],
      components: [],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    logger.warn(`Schwarzmarkt-Bestellung fehlgeschlagen: ${(error as Error).message}`);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Bestellung fehlgeschlagen').setDescription((error as Error).message)],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    } else {
      await replyError(interaction, (error as Error).message);
    }
  }
}

export async function handleMarketOrderManagerButton(interaction: ButtonInteraction): Promise<void> {
  const connId = interaction.customId.split(':')[1];
  try {
    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');
    if (!connId) throw new Error('Gameserver-Scope fehlt. Bitte das Management-Embed neu synchronisieren.');
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
      const username = member?.displayName ?? member?.user.username ?? order.userDiscordId;
      const count = order.purchases.reduce((sum, purchase) => sum + purchase.quantity, 0);
      const items = order.purchases.flatMap(purchase => purchase.deliveryItems.map(item => `${item.itemText} x${item.quantity}`)).filter(Boolean).join(', ');
      return {
        label: `${username} · ${count} Artikel · ${order.totalAmount.toLocaleString('de-DE')}`.slice(0, 100),
        value: order.id,
        description: items ? items.slice(0, 100) : undefined,
      };
    }));

    const select = new StringSelectMenuBuilder()
      .setCustomId(`vacct_mgr_order_sel:${connId}`)
      .setPlaceholder('Bestellung nach Username auswählen')
      .addOptions(options);
    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('Bestellung abschließen')
        .setDescription('Wähle die offene Bestellung anhand des **Usernames** aus. Danach wird der Kunde automatisch erwähnt und als „Bestellung fertig“ benachrichtigt.')],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    await replyError(interaction, (error as Error).message);
  }
}

async function postOrderReadyEmbed(client: Client, orderId: string, guildId: string, connId: string, userDiscordId: string): Promise<void> {
  const projection = await prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    select: { orderReadyChannelId: true },
  });
  if (!projection?.orderReadyChannelId) throw new Error('Bestellung-fertig-Kanal ist nicht konfiguriert.');
  const channel = await client.channels.fetch(projection.orderReadyChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Bestellung-fertig-Kanal ist nicht erreichbar.');

  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle('✅ Bestellung fertig')
    .setDescription('Deine Bestellung ist fertig und kann abgeholt werden.')
    .addFields({ name: 'Status', value: '**Bestellung fertig**', inline: true })
    .setFooter({ text: 'V-Bot · Schwarzmarkt · automatische Löschung nach 1 Stunde' })
    .setTimestamp();
  const message = await (channel as TextChannel).send({
    content: `<@${userDiscordId}>`,
    embeds: [embed],
    allowedMentions: { users: [userDiscordId] },
  });
  await scheduleMarketOrderReadyNoticeOneHour({
    guildId: asGuildId(guildId),
    nitradoConnId: asNitradoConnId(connId),
    orderId,
    channelId: channel.id,
    userDiscordId: asUserDiscordId(userDiscordId),
    messageId: message.id,
  });
}

export async function handleMarketOrderManagerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const connId = interaction.customId.split(':')[1];
  const orderId = interaction.values[0];
  try {
    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');
    if (!connId) throw new Error('Gameserver-Scope fehlt. Bitte das Management-Embed neu synchronisieren.');
    if (!orderId) throw new Error('Keine Bestellung ausgewählt.');
    const guildId = asGuildId(interaction.guildId);
    const nitradoConnId = asNitradoConnId(connId);
    const accounts = (await listManagedVirtualAccounts(guildId, nitradoConnId, asUserDiscordId(interaction.user.id)))
      .filter(account => account.kind === 'MARKET_VENDOR');
    const orderRows = (await Promise.all(accounts.map(account => listOpenMarketOrders(guildId, nitradoConnId, account.id)))).flat();
    const order = orderRows.find(row => row.id === orderId);
    if (!order) throw new Error('Bestellung ist nicht mehr offen oder dir nicht zugewiesen.');

    await interaction.deferUpdate();
    const result = await closeMarketOrder({
      guildId,
      nitradoConnId,
      orderId,
      vendorAccountId: order.vendorAccountId,
      actorDiscordId: asUserDiscordId(interaction.user.id),
    });
    if (result.changed) await postOrderReadyEmbed(interaction.client, orderId, interaction.guildId, connId, order.userDiscordId);
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(0x22c55e)
        .setTitle('✅ Bestellung abgeschlossen')
        .setDescription(`Bestellung von <@${order.userDiscordId}> wurde abgeschlossen. Der Kunde wurde erwähnt; das Fertig-Embed wird nach **1 Stunde** automatisch gelöscht.`)],
      components: [],
      allowedMentions: { users: [order.userDiscordId] },
    });
  } catch (error) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle('Bestellung konnte nicht abgeschlossen werden').setDescription((error as Error).message)],
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    } else {
      await replyError(interaction, (error as Error).message);
    }
  }
}

/** Alte, bereits geöffnete Auswahl-Nachrichten werden bewusst fail-closed beendet. */
export async function handleLegacyMarketOrderSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  await replyError(interaction, 'Diese Bestell-Auswahl stammt aus einer älteren Version. Bitte „Bestellen“ erneut öffnen.');
}

export async function handleLegacyMarketOrderConfirmButton(interaction: ButtonInteraction): Promise<void> {
  await replyError(interaction, 'Diese Bestell-Bestätigung stammt aus einer älteren Version. Bitte „Bestellen“ erneut öffnen.');
}
