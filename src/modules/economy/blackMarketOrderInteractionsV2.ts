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
import { vEmbed } from '../../utils/embedDesign';
import { listMarketListings, type MarketListingView } from './blackMarket';
import { getConfig } from './repository';
import {
  attachMarketOrderMessage,
  closeMarketOrder,
  getMarketOrder,
  listManagedOpenMarketOrdersPage,
  type MarketOrderView,
} from './blackMarketOrder';
import {
  createMarketOrderV2,
  MAX_MARKET_ORDER_LINES,
  MAX_MARKET_ORDER_UNITS,
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
    embeds: [vEmbed(0xe74c3c).setTitle('Bestellung abgelehnt').setDescription(message)],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] },
  } as const;
  if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => undefined);
  else await interaction.reply(payload).catch(() => undefined);
}

interface OrderButtonContextRow {
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string | null;
}

function parseVendorOrderAnchor(customId: string): string | null {
  if (customId === 'marketorder:open:0') return null;
  const parts = customId.split(':');
  if (parts.length !== 4 || parts[0] !== 'marketorder' || parts[1] !== 'open' || parts[2] !== 'v1') {
    throw new Error('Diese Bestell-Aktion ist ungültig oder veraltet. Bitte den aktuellen Händlerkatalog verwenden.');
  }
  const catalogProjectionId = parts[3];
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(catalogProjectionId)) {
    throw new Error('Diese Bestell-Aktion ist ungültig oder veraltet. Bitte den aktuellen Händlerkatalog verwenden.');
  }
  return catalogProjectionId;
}

async function resolveOrderButtonContext(args: {
  customId: string;
  guildId: string;
  channelId: string;
  messageId: string;
}): Promise<{ guildId: string; connId: string; vendorAccountId: string | null }> {
  const catalogProjectionId = parseVendorOrderAnchor(args.customId);
  if (catalogProjectionId === null) {
    const rows = await prisma.$queryRawUnsafe<OrderButtonContextRow[]>(
      `SELECT m."guildId", m."nitradoConnId", NULL::text AS "vendorAccountId"
       FROM "EconomyMarketDiscordMessage" m
       JOIN "EconomyMarketDiscordProjection" p
         ON p."id"=m."projectionId" AND p."guildId"=m."guildId" AND p."nitradoConnId"=m."nitradoConnId"
       WHERE m."kind"='ORDER_BUTTON' AND m."guildId"=$1 AND m."channelId"=$2 AND m."messageId"=$3
         AND p."catalogChannelId"=m."channelId"
         AND p."directBuyEnabled"=TRUE AND p."orderChannelId" IS NOT NULL AND p."orderReadyChannelId" IS NOT NULL
       LIMIT 1`,
      args.guildId,
      args.channelId,
      args.messageId,
    );
    const row = rows[0];
    if (!row) throw new Error('Diese Bestell-Aktion ist veraltet oder Bestellungen sind nicht mehr aktiv.');
    return { guildId: row.guildId, connId: row.nitradoConnId, vendorAccountId: null };
  }

  const rows = await prisma.$queryRawUnsafe<OrderButtonContextRow[]>(
    `SELECT c."guildId", c."nitradoConnId", c."vendorAccountId"
     FROM "EconomyMarketVendorCatalogProjection" c
     JOIN "EconomyMarketDiscordProjection" p
       ON p."id"=c."projectionId" AND p."guildId"=c."guildId" AND p."nitradoConnId"=c."nitradoConnId"
     JOIN "EconomyVirtualAccount" v
       ON v."id"=c."vendorAccountId" AND v."guildId"=c."guildId" AND v."nitradoConnId"=c."nitradoConnId"
     WHERE c."id"=$1 AND c."guildId"=$2 AND c."channelId"=$3 AND c."catalogMessageId"=$4
       AND p."catalogChannelId"=c."channelId"
       AND p."directBuyEnabled"=TRUE AND p."orderChannelId" IS NOT NULL AND p."orderReadyChannelId" IS NOT NULL
       AND v."kind"='MARKET_VENDOR' AND v."status"='ACTIVE'
       AND EXISTS (
         SELECT 1 FROM "EconomyMarketListing" l
         WHERE l."vendorAccountId"=c."vendorAccountId"
           AND l."guildId"=c."guildId" AND l."nitradoConnId"=c."nitradoConnId"
           AND l."active"=TRUE AND l."archivedAt" IS NULL
       )
     LIMIT 1`,
    catalogProjectionId,
    args.guildId,
    args.channelId,
    args.messageId,
  );
  const row = rows[0];
  if (!row?.vendorAccountId) throw new Error('Dieser Händler-Bestellbutton ist veraltet oder nicht mehr aktiv.');
  return { guildId: row.guildId, connId: row.nitradoConnId, vendorAccountId: row.vendorAccountId };
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
  const [allListings, cfg, boundVendor] = await Promise.all([
    listMarketListings(asGuildId(draft.guildId), asNitradoConnId(draft.connId), false),
    getConfig(asGuildId(draft.guildId), asNitradoConnId(draft.connId)),
    draft.vendorAccountId
      ? getVirtualAccountById(asGuildId(draft.guildId), asNitradoConnId(draft.connId), draft.vendorAccountId)
      : Promise.resolve(null),
  ]);
  if (draft.vendorAccountId && (!boundVendor || boundVendor.kind !== 'MARKET_VENDOR' || boundVendor.status !== 'ACTIVE')) {
    throw new Error('Dieser Händler ist nicht mehr aktiv. Bitte die aktuelle Verkaufsliste verwenden.');
  }
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
  const vendor = boundVendor?.name ?? null;

  const embed = vEmbed(0x22c55e)
    .setTitle('🛒 Bestellung aufgeben')
    .setDescription(lines.length
      ? lines.map(line => `• **${line.listing.name}** × ${line.quantity} — ${(line.listing.price * BigInt(line.quantity)).toLocaleString('de-DE')} ${cfg.emoji}`).join('\n')
      : 'Wähle einen Artikel und eine Menge aus und füge ihn dem Warenkorb hinzu.')
    .addFields(
      { name: 'Virtuelles Konto', value: vendor ?? 'Noch nicht gewählt', inline: true },
      { name: 'Warenkorb', value: `${Object.keys(draft.lines).length}/${MAX_MARKET_ORDER_LINES} Positionen · ${totalUnits(draft)} Stück`, inline: true },
      { name: 'Gesamtsumme', value: `**${total.toLocaleString('de-DE')} ${cfg.emoji}**`, inline: true },
    )
    .setFooter({ text: 'Zahlung aus Wallet oder Bank · max. 25 Positionen · je Position 1–20 Stück' });

  const listingSelect = new StringSelectMenuBuilder()
    .setCustomId(`marketorder:item:${token}`)
    .setPlaceholder(totalPages > 1 ? `Artikel wählen · Seite ${draft.page + 1}/${totalPages}` : 'Artikel wählen')
    .setMinValues(1).setMaxValues(1)
    .addOptions(pageItems.map(listing => ({
      label: optionLabel(listing), value: listing.id,
      description: `${listing.price.toLocaleString('de-DE')} ${cfg.currencyName} · ${listing.sku}`.slice(0, 100),
      default: listing.id === draft.selectedListingId,
    })));
  const quantitySelect = new StringSelectMenuBuilder()
    .setCustomId(`marketorder:qty:${token}`)
    .setPlaceholder(`Menge wählen · aktuell ${draft.selectedQuantity}`)
    .setMinValues(1).setMaxValues(1)
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
  if (totalPages > 1) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`marketorder:page:${token}:${Math.max(0, draft.page - 1)}`).setLabel('◀ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(draft.page <= 0),
    new ButtonBuilder().setCustomId(`marketorder:page:${token}:${Math.min(totalPages - 1, draft.page + 1)}`).setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(draft.page >= totalPages - 1),
  ));
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`marketorder:cancel:${token}`).setLabel('Abbrechen').setStyle(ButtonStyle.Danger),
  ));
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] as never[] } };
}

export async function handleMarketOrderButton(interaction: ButtonInteraction): Promise<void> {
  try {
    if (!interaction.guildId || !interaction.channelId) throw new Error('Bestellungen sind nur in einem Discord-Server möglich.');
    if (!interaction.client.user || interaction.message.author.id !== interaction.client.user.id) throw new Error('Diese Bestell-Nachricht wird nicht vom aktuellen V-Bot verwaltet.');
    const context = await resolveOrderButtonContext({ customId: interaction.customId, guildId: interaction.guildId, channelId: interaction.channelId, messageId: interaction.message.id });
    const token = newToken();
    const draft: CartDraft = { guildId: context.guildId, connId: context.connId, userDiscordId: interaction.user.id, lines: {}, vendorAccountId: context.vendorAccountId, selectedListingId: null, selectedQuantity: 1, page: 0, createdAt: Date.now() };
    carts.set(token, draft);
    await interaction.reply({ ...(await cartPayload(token, draft)), flags: MessageFlags.Ephemeral });
  } catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderItemSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try { const token = parseToken(interaction.customId); const draft = getCartForUser(token, interaction.user.id); draft.selectedListingId = interaction.values[0] ?? null; await interaction.update(await cartPayload(token, draft)); }
  catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderQuantitySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId); const draft = getCartForUser(token, interaction.user.id); const quantity = Number(interaction.values[0] ?? '1');
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_MARKET_ORDER_UNITS) throw new Error('Ungültige Bestellmenge.');
    draft.selectedQuantity = quantity; await interaction.update(await cartPayload(token, draft));
  } catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderAddButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const token = parseToken(interaction.customId); const draft = getCartForUser(token, interaction.user.id);
    if (!draft.selectedListingId) throw new Error('Bitte zuerst einen Artikel auswählen.');
    const listing = await prisma.economyMarketListing.findFirst({ where: { id: draft.selectedListingId, guildId: draft.guildId, nitradoConnId: draft.connId, active: true, archivedAt: null }, select: { id: true, vendorAccountId: true, name: true } });
    if (!listing) throw new Error('Der ausgewählte Artikel ist nicht mehr verfügbar.');
    if (draft.vendorAccountId && draft.vendorAccountId !== listing.vendorAccountId) throw new Error('Eine Bestellung kann nur Artikel desselben virtuellen Händlerkontos enthalten.');
    const current = draft.lines[listing.id] ?? 0; const next = current + draft.selectedQuantity;
    if (next > MAX_MARKET_ORDER_UNITS) throw new Error(`Von ${listing.name} sind pro Bestellung maximal ${MAX_MARKET_ORDER_UNITS} Stück möglich.`);
    if (current === 0 && Object.keys(draft.lines).length >= MAX_MARKET_ORDER_LINES) throw new Error(`Eine Bestellung darf maximal ${MAX_MARKET_ORDER_LINES} verschiedene Artikel enthalten.`);
    draft.vendorAccountId = listing.vendorAccountId; draft.lines[listing.id] = next; draft.selectedListingId = null; draft.selectedQuantity = 1; draft.page = 0;
    await interaction.update(await cartPayload(token, draft));
  } catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderPageButton(interaction: ButtonInteraction): Promise<void> {
  try { const parts = interaction.customId.split(':'); const token = parts[2]; const page = Number(parts[3] ?? '0'); if (!token) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut öffnen.'); const draft = getCartForUser(token, interaction.user.id); draft.page = Number.isFinite(page) ? Math.max(0, page) : 0; draft.selectedListingId = null; await interaction.update(await cartPayload(token, draft)); }
  catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderCancelButton(interaction: ButtonInteraction): Promise<void> {
  try { const token = parseToken(interaction.customId); const draft = getCartForUser(token, interaction.user.id); carts.delete(token); await interaction.update({ embeds: [vEmbed(0x6b7280).setTitle('Bestellung abgebrochen').setDescription(`Der Warenkorb mit ${totalUnits(draft)} Artikel(n) wurde verworfen. Es wurde nichts bezahlt.`)], components: [], allowedMentions: { parse: [] } }); }
  catch (error) { await replyError(interaction, (error as Error).message); }
}

function orderItemLines(order: MarketOrderView, names: Map<string, string>, currencyEmoji: string): string[] {
  return order.purchases.map(purchase => {
    const name = names.get(purchase.listingId) ?? purchase.deliveryItems[0]?.itemText ?? 'Artikel';
    return `• **${name}** — ${purchase.quantity} × ${purchase.unitPrice.toLocaleString('de-DE')} = **${purchase.amount.toLocaleString('de-DE')} ${currencyEmoji}**`;
  });
}

async function postOrderChannelEmbed(client: Client, order: MarketOrderView, currencyName: string, currencyEmoji: string): Promise<void> {
  const projection = await prisma.economyMarketDiscordProjection.findUnique({ where: { guildId_nitradoConnId: { guildId: order.guildId, nitradoConnId: order.nitradoConnId } }, select: { orderChannelId: true } });
  if (!projection?.orderChannelId) throw new Error('Bestellungs-Kanal ist nicht konfiguriert.');
  const channel = await client.channels.fetch(projection.orderChannelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Bestellungs-Kanal ist nicht erreichbar.');
  const guild = client.guilds.cache.get(order.guildId) ?? await client.guilds.fetch(order.guildId).catch(() => null);
  const member = guild ? await guild.members.fetch(order.userDiscordId).catch(() => null) : null;
  const username = member?.displayName ?? member?.user.username ?? order.userDiscordId;
  const vendor = await vendorName(order.guildId, order.nitradoConnId, order.vendorAccountId);
  const listings = await prisma.economyMarketListing.findMany({ where: { id: { in: order.purchases.map(purchase => purchase.listingId) }, guildId: order.guildId, nitradoConnId: order.nitradoConnId }, select: { id: true, name: true } });
  const names = new Map(listings.map(listing => [listing.id, listing.name]));
  const lines = orderItemLines(order, names, currencyEmoji);
  const createdUnix = Math.floor(order.createdAt.getTime() / 1000);
  const sourcePocket = order.purchases[0]?.sourcePocket;
  const payment = sourcePocket === 'BANK' ? 'Bank' : 'Wallet';
  const buyer = `${username.slice(0, 900)}\n<@${order.userDiscordId}> · \`${order.userDiscordId}\``;
  const embed = vEmbed(0xf59e0b).setTitle('📦 Bestellung ausstehend').addFields(
    { name: 'Händler', value: vendor, inline: true }, { name: 'Username', value: buyer, inline: true }, { name: 'Status', value: '**Bestellung ausstehend**', inline: true },
    { name: 'Datum', value: `<t:${createdUnix}:D>`, inline: true }, { name: 'Uhrzeit', value: `<t:${createdUnix}:T>`, inline: true }, { name: 'Zahlung', value: payment, inline: true },
    { name: 'Gesamt', value: `**${order.totalAmount.toLocaleString('de-DE')} ${currencyEmoji}** (${currencyName})`, inline: true },
    { name: 'Artikel', value: lines.join('\n').slice(0, 1024), inline: false },
  ).setFooter({ text: 'V-Bot · Schwarzmarkt · Bestellung offen' }).setTimestamp(order.createdAt);
  const message = await (channel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
  await attachMarketOrderMessage({ guildId: asGuildId(order.guildId), nitradoConnId: asNitradoConnId(order.nitradoConnId), orderId: order.id, channelId: channel.id, messageId: message.id });
}

export async function handleMarketOrderPayButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':'); const pocketCode = parts[2]; const token = parts[3];
  try {
    if (!token) throw new Error('Bestell-Auswahl ist abgelaufen. Bitte erneut öffnen.'); const draft = getCartForUser(token, interaction.user.id);
    const lines = Object.entries(draft.lines).map(([listingId, quantity]) => ({ listingId, quantity })); if (lines.length === 0) throw new Error('Der Warenkorb ist leer.');
    const sourcePocket = pocketCode === 'b' ? 'BANK' : pocketCode === 'w' ? 'WALLET' : null; if (!sourcePocket) throw new Error('Ungültige Zahlungsart.');
    await interaction.deferUpdate(); const cfg = await getConfig(asGuildId(draft.guildId), asNitradoConnId(draft.connId));
    const result = await createMarketOrderV2({ guildId: asGuildId(draft.guildId), nitradoConnId: asNitradoConnId(draft.connId), userDiscordId: asUserDiscordId(draft.userDiscordId), lines, sourcePocket, idempotencyKey: token }); carts.delete(token);
    let discordWarning: string | null = null;
    try { await postOrderChannelEmbed(interaction.client, result.order, cfg.currencyName, cfg.emoji); }
    catch (embedError) { discordWarning = ' Die Zahlung war erfolgreich und die Bestellung wurde gespeichert, aber das Bestell-Embed konnte nicht gesendet werden. Bitte einen Admin informieren.'; logger.error(`Bestell-Embed fehlgeschlagen (${result.order.id}):`, embedError as Error); }
    await interaction.editReply({ embeds: [vEmbed(discordWarning ? 0xf59e0b : 0x22c55e).setTitle(discordWarning ? 'Bestellung bezahlt' : 'Bestellung aufgegeben').setDescription(`**${result.order.totalAmount.toLocaleString('de-DE')} ${cfg.emoji}** wurden aus deiner **${sourcePocket === 'BANK' ? 'Bank' : 'Wallet'}** abgebucht.${discordWarning ?? ' Deine Bestellung steht nun auf **ausstehend**.'}`)], components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    logger.warn(`Schwarzmarkt-Bestellung fehlgeschlagen: ${(error as Error).message}`);
    if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [vEmbed(0xe74c3c).setTitle('Bestellung fehlgeschlagen').setDescription((error as Error).message)], components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
    else await replyError(interaction, (error as Error).message);
  }
}

async function managedVendorIds(
  guildId: ReturnType<typeof asGuildId>,
  nitradoConnId: ReturnType<typeof asNitradoConnId>,
  userId: string,
): Promise<string[]> {
  const accounts = (await listManagedVirtualAccounts(guildId, nitradoConnId, asUserDiscordId(userId)))
    .filter(account => account.kind === 'MARKET_VENDOR');
  if (accounts.length === 0) throw new Error('Dir ist kein Schwarzmarkt-Händlerkonto zugewiesen.');
  return accounts.map(account => account.id);
}

type ManagerComponentKind = 'vacct_mgr_order' | 'vacct_mgr_order_page' | 'vacct_mgr_order_sel';

function parseMarketOrderManagerComponentId(customId: string, expectedKind: ManagerComponentKind): { connId: string; page: number } {
  const parts = customId.split(':');
  const expectedLength = expectedKind === 'vacct_mgr_order' ? 2 : 3;
  if (parts.length !== expectedLength || parts[0] !== expectedKind || !parts[1]) {
    throw new Error('Diese Manager-Aktion ist ungültig oder veraltet. Bitte das Panel neu öffnen.');
  }
  const connId = String(asNitradoConnId(parts[1]));
  if (expectedKind === 'vacct_mgr_order') return { connId, page: 0 };
  const rawPage = parts[2];
  if (!rawPage || !/^(0|[1-9][0-9]*)$/.test(rawPage)) {
    throw new Error('Diese Manager-Seite ist ungültig. Bitte das Panel neu öffnen.');
  }
  const page = Number(rawPage);
  if (!Number.isSafeInteger(page)) throw new Error('Diese Manager-Seite ist ungültig. Bitte das Panel neu öffnen.');
  return { connId, page };
}

async function managerPayload(interaction: ComponentInteraction, connId: string, requestedPage: number) {
  if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');
  const guildId = asGuildId(interaction.guildId); const nitradoConnId = asNitradoConnId(connId);
  const vendorIds = await managedVendorIds(guildId, nitradoConnId, interaction.user.id);
  const result = await listManagedOpenMarketOrdersPage(guildId, nitradoConnId, vendorIds, PAGE_SIZE, requestedPage * PAGE_SIZE);
  if (result.total === 0) throw new Error('Aktuell sind keine offenen Bestellungen vorhanden.');
  const totalPages = Math.max(1, Math.ceil(result.total / PAGE_SIZE));
  const page = Math.floor(result.offset / PAGE_SIZE);
  const pageOrders = result.orders;
  const guild = interaction.guild;
  const options = await Promise.all(pageOrders.map(async order => {
    const member = guild ? guild.members.cache.get(order.userDiscordId) ?? await guild.members.fetch(order.userDiscordId).catch(() => null) : null;
    const username = member?.displayName ?? member?.user.username ?? order.userDiscordId; const count = order.purchases.reduce((sum, purchase) => sum + purchase.quantity, 0);
    const items = order.purchases.flatMap(purchase => purchase.deliveryItems.map(item => `${item.itemText} x${item.quantity}`)).filter(Boolean).join(', ');
    return { label: `${username} · Bestellung ${order.id.slice(-8)} · ${count} Artikel · ${order.totalAmount.toLocaleString('de-DE')}`.slice(0, 100), value: order.id, description: items ? items.slice(0, 100) : undefined };
  }));
  const select = new StringSelectMenuBuilder().setCustomId(`vacct_mgr_order_sel:${connId}:${page}`).setPlaceholder(`Bestellung auswählen · Seite ${page + 1}/${totalPages}`).addOptions(options);
  const components: Array<ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>> = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)];
  if (totalPages > 1) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vacct_mgr_order_page:${connId}:${Math.max(0, page - 1)}`).setLabel('◀ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`vacct_mgr_order_page:${connId}:${Math.min(totalPages - 1, page + 1)}`).setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  ));
  return { embeds: [vEmbed(0x5865f2).setTitle('Bestellung abschließen').setDescription(`Wähle eine offene Bestellung anhand des **Usernames** aus. Es werden alle offenen Bestellungen angezeigt · Seite **${page + 1}/${totalPages}**.`)], components, allowedMentions: { parse: [] as never[] } };
}

export async function handleMarketOrderManagerButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const { connId } = parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order');
    await interaction.reply({ ...(await managerPayload(interaction, connId, 0)), flags: MessageFlags.Ephemeral });
  } catch (error) { await replyError(interaction, (error as Error).message); }
}

export async function handleMarketOrderManagerPageButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const { connId, page } = parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_page');
    await interaction.update(await managerPayload(interaction, connId, page));
  } catch (error) { await replyError(interaction, (error as Error).message); }
}

async function editOriginalOrderMessage(client: Client, order: MarketOrderView): Promise<void> {
  if (!order.orderChannelId || !order.orderMessageId) return;
  const channel = await client.channels.fetch(order.orderChannelId).catch(() => null); if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await channel.messages.fetch(order.orderMessageId).catch(() => null); if (!message) return;
  const existing = message.embeds[0]?.toJSON();
  const fields = (existing?.fields ?? []).map(field => field.name === 'Status' ? { ...field, value: '**Bestellung beendet**' } : field);
  await message.edit({ embeds: [new EmbedBuilder(existing).setColor(0x22c55e).setTitle('✅ Bestellung beendet').setFields(fields).setFooter({ text: 'V-Bot · Schwarzmarkt · Verschwindet nach 1 Minute' }).setTimestamp(order.closedAt ?? new Date())], components: [], allowedMentions: { parse: [] } });
}

export async function handleMarketOrderManagerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  try {
    const { connId } = parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_sel');
    const orderId = interaction.values[0];
    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.'); if (!orderId) throw new Error('Keine Bestellung ausgewählt.');
    const guildId = asGuildId(interaction.guildId); const nitradoConnId = asNitradoConnId(connId);
    const vendorIds = await managedVendorIds(guildId, nitradoConnId, interaction.user.id);
    const order = await getMarketOrder(guildId, nitradoConnId, orderId);
    if (!order || order.status !== 'OPEN' || !vendorIds.includes(order.vendorAccountId)) {
      throw new Error('Bestellung ist nicht mehr offen oder dir nicht zugewiesen.');
    }
    await interaction.deferUpdate();
    const result = await closeMarketOrder({ guildId, nitradoConnId, orderId, vendorAccountId: order.vendorAccountId, actorDiscordId: asUserDiscordId(interaction.user.id) });
    if (result.changed) await editOriginalOrderMessage(interaction.client, result.order).catch(error => logger.warn(`Bestell-Embed Abschluss-Update fehlgeschlagen (${orderId}): ${(error as Error).message}`));
    await interaction.editReply({ embeds: [vEmbed(0x22c55e).setTitle('Bestellung beendet').setDescription(`Bestellung von <@${order.userDiscordId}> wurde beendet. Die Fertig-Benachrichtigung ist persistent eingeplant und wird retry-sicher zugestellt.`)], components: [], allowedMentions: { users: [order.userDiscordId] } });
  } catch (error) {
    if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [vEmbed(0xe74c3c).setTitle('Bestellung konnte nicht abgeschlossen werden').setDescription((error as Error).message)], components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
    else await replyError(interaction, (error as Error).message);
  }
}

export async function handleLegacyMarketOrderSelect(interaction: StringSelectMenuInteraction): Promise<void> { await replyError(interaction, 'Diese Bestell-Auswahl stammt aus einer älteren Version. Bitte „Bestellen“ erneut öffnen.'); }
export async function handleLegacyMarketOrderConfirmButton(interaction: ButtonInteraction): Promise<void> { await replyError(interaction, 'Diese Bestell-Bestätigung stammt aus einer älteren Version. Bitte „Bestellen“ erneut öffnen.'); }
