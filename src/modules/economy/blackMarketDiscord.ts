import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  TextChannel,
  type ButtonInteraction,
  type Message,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import { asGuildId, asNitradoConnId, type GuildId, type NitradoConnId } from '../../types/scope';
import { safeEmbedDescription, safeEmbedField } from '../../utils/embedSanitize';
import { vEmbed } from '../../utils/embedDesign';
import { getConfig } from './repository';
import { listMarketListings, type MarketListingView } from './blackMarket';

const CATALOG_ITEMS_PER_MESSAGE = 5;
const syncInFlight = new Map<string, Promise<unknown>>();

type ProjectionRow = {
  id: string;
  guildId: string;
  nitradoConnId: string;
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  orderChannelId: string | null;
  orderReadyChannelId: string | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
};

type ProjectionMessageRow = {
  id: string;
  projectionId: string;
  guildId: string;
  nitradoConnId: string;
  kind: string;
  pageIndex: number | null;
  listingId: string | null;
  channelId: string;
  messageId: string;
};

type VendorCatalogProjectionRow = {
  id: string;
  projectionId: string;
  guildId: string;
  nitradoConnId: string;
  vendorAccountId: string;
  channelId: string;
  catalogMessageId: string;
  orderButtonMessageId: string | null;
  currentPage: number;
};

interface ActiveVendorCatalog {
  vendorAccountId: string;
  vendorName: string;
  listings: MarketListingView[];
}

export interface MarketDiscordProjectionView {
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  orderChannelId: string | null;
  orderReadyChannelId: string | null;
  catalogMessageCount: number;
  directBuyMessageCount: number;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}

function scopeKey(guildId: GuildId | string, connId: NitradoConnId | string): string {
  return `${String(guildId)}:${String(connId)}`;
}

function chunk<T>(rows: T[], size: number): T[][] {
  if (rows.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
}

function newCatalogProjectionId(): string {
  return randomUUID().replace(/-/g, '');
}

async function readProjection(guildId: GuildId, connId: NitradoConnId): Promise<ProjectionRow | null> {
  return prisma.economyMarketDiscordProjection.findUnique({
    where: { guildId_nitradoConnId: { guildId: String(guildId), nitradoConnId: String(connId) } },
  });
}

async function readMessageRows(projectionId: string): Promise<ProjectionMessageRow[]> {
  return prisma.economyMarketDiscordMessage.findMany({
    where: { projectionId },
    orderBy: [{ kind: 'asc' }, { pageIndex: 'asc' }, { listingId: 'asc' }],
  });
}

async function readVendorCatalogRows(projectionId: string): Promise<VendorCatalogProjectionRow[]> {
  return prisma.economyMarketVendorCatalogProjection.findMany({
    where: { projectionId },
    orderBy: [{ vendorAccountId: 'asc' }],
  });
}

async function viewFor(row: ProjectionRow): Promise<MarketDiscordProjectionView> {
  const [messages, vendorCatalogCount] = await Promise.all([
    prisma.economyMarketDiscordMessage.findMany({
      where: { projectionId: row.id },
      select: { kind: true },
    }),
    prisma.economyMarketVendorCatalogProjection.count({ where: { projectionId: row.id } }),
  ]);
  const legacyCatalogCount = messages.filter(message => message.kind === 'CATALOG').length;
  return {
    catalogChannelId: row.catalogChannelId,
    directBuyEnabled: row.directBuyEnabled,
    directBuyChannelId: row.directBuyChannelId,
    orderChannelId: row.orderChannelId,
    orderReadyChannelId: row.orderReadyChannelId,
    catalogMessageCount: vendorCatalogCount > 0 ? vendorCatalogCount : legacyCatalogCount,
    directBuyMessageCount: messages.filter(message => message.kind === 'DIRECT_BUY').length,
    lastSyncedAt: row.lastSyncedAt,
    lastSyncError: row.lastSyncError,
  };
}

export async function getMarketDiscordProjection(guildId: GuildId, connId: NitradoConnId): Promise<MarketDiscordProjectionView | null> {
  const row = await readProjection(guildId, connId);
  return row ? viewFor(row) : null;
}

async function requireProjectionChannel(client: Client, guildId: GuildId, channelId: string, label: string): Promise<TextChannel> {
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const fetched = await guild.channels.fetch(channelId).catch(() => null);
  if (!fetched || fetched.type !== ChannelType.GuildText) throw new Error(`${label} muss ein normaler Discord-Textkanal sein.`);
  const channel = fetched as TextChannel;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('V-Bot-Mitglied konnte in der Guild nicht aufgelöst werden.');
  const perms = channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
  ];
  if (!perms?.has(required)) throw new Error(`V-Bot benötigt im ${label} Lesen, Schreiben, Embed-Links und Nachrichtenverlauf.`);
  return channel;
}

function isUnknownDiscordResource(error: unknown, code: number): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = (error as { code?: unknown }).code;
  return value === code || value === String(code);
}

async function fetchManagedMessage(channel: TextChannel, messageId: string): Promise<Message | null> {
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (isUnknownDiscordResource(error, 10008)) return null;
    throw error;
  }
}

async function deleteDiscordMessageRef(client: Client, channelId: string, messageId: string): Promise<void> {
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    if (isUnknownDiscordResource(error, 10003)) return;
    throw error;
  }
  if (!channel) return;
  if (channel.type !== ChannelType.GuildText) throw new Error(`Verwalteter Schwarzmarkt-Kanal ${channelId} ist kein Textkanal mehr.`);
  const message = await fetchManagedMessage(channel as TextChannel, messageId);
  if (!message) return;
  try {
    await message.delete();
  } catch (error) {
    if (!isUnknownDiscordResource(error, 10008)) throw error;
  }
}

async function deleteDiscordMessage(client: Client, row: ProjectionMessageRow): Promise<void> {
  await deleteDiscordMessageRef(client, row.channelId, row.messageId);
}

async function removeProjectionMessage(client: Client, row: ProjectionMessageRow): Promise<void> {
  await deleteDiscordMessage(client, row);
  await prisma.economyMarketDiscordMessage.deleteMany({ where: { id: row.id, projectionId: row.projectionId } });
}

async function removeVendorCatalogProjection(client: Client, row: VendorCatalogProjectionRow): Promise<void> {
  await deleteDiscordMessageRef(client, row.channelId, row.catalogMessageId);
  if (row.orderButtonMessageId) await deleteDiscordMessageRef(client, row.channelId, row.orderButtonMessageId);
  await prisma.economyMarketVendorCatalogProjection.deleteMany({
    where: {
      id: row.id,
      projectionId: row.projectionId,
      guildId: row.guildId,
      nitradoConnId: row.nitradoConnId,
      vendorAccountId: row.vendorAccountId,
    },
  });
}

function vendorCatalogEmbed(args: {
  vendorName: string;
  listings: MarketListingView[];
  pageIndex: number;
  totalPages: number;
  currencyName: string;
  currencyEmoji: string;
}): EmbedBuilder {
  const embed = vEmbed(0x8b5cf6)
    .setTitle(`🛒 ${safeEmbedField(args.vendorName, 220)}`)
    .setDescription(`Aktive Angebote dieses Händlers · Preise in **${safeEmbedDescription(args.currencyName)} ${args.currencyEmoji}**`)
    .setFooter({ text: `V-Bot · Schwarzmarkt · Live-Sync · Seite ${args.pageIndex + 1}/${args.totalPages}` })
    .setTimestamp();

  for (const listing of args.listings) {
    const description = listing.description ? `\n${safeEmbedField(listing.description, 500)}` : '';
    embed.addFields({
      name: safeEmbedField(listing.name, 250),
      value: `**${listing.price.toLocaleString('de-DE')} ${args.currencyEmoji}** · ${safeEmbedField(args.currencyName, 120)}${description}`,
      inline: false,
    });
  }
  return embed;
}

function vendorCatalogComponents(args: { catalogProjectionId: string; pageIndex: number; totalPages: number; ordersEnabled: boolean }) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  if (args.totalPages > 1) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`marketcat:v1:page:${args.catalogProjectionId}:${Math.max(0, args.pageIndex - 1)}`)
        .setLabel('◀ Zurück')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(args.pageIndex <= 0),
      new ButtonBuilder()
        .setCustomId(`marketcat:v1:page:${args.catalogProjectionId}:${Math.min(args.totalPages - 1, args.pageIndex + 1)}`)
        .setLabel('Weiter ▶')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(args.pageIndex >= args.totalPages - 1),
    ));
  }
  if (args.ordersEnabled) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`marketorder:open:v1:${args.catalogProjectionId}`)
        .setLabel('Bestellung')
        .setEmoji('🛒')
        .setStyle(ButtonStyle.Success),
    ));
  }
  return rows;
}

async function loadActiveVendorCatalogs(
  guildId: GuildId,
  connId: NitradoConnId,
  listings: MarketListingView[],
): Promise<ActiveVendorCatalog[]> {
  const vendorIds = [...new Set(listings.map(listing => listing.vendorAccountId))];
  if (vendorIds.length === 0) return [];
  const vendors = await prisma.economyVirtualAccount.findMany({
    where: {
      id: { in: vendorIds },
      guildId: String(guildId),
      nitradoConnId: String(connId),
      kind: 'MARKET_VENDOR',
      status: 'ACTIVE',
    },
    select: { id: true, name: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const vendorNames = new Map(vendors.map(vendor => [vendor.id, vendor.name]));
  const grouped = new Map<string, MarketListingView[]>();
  for (const listing of listings) {
    if (!vendorNames.has(listing.vendorAccountId)) continue;
    const rows = grouped.get(listing.vendorAccountId) ?? [];
    rows.push(listing);
    grouped.set(listing.vendorAccountId, rows);
  }
  return vendors.flatMap(vendor => {
    const vendorListings = grouped.get(vendor.id) ?? [];
    return vendorListings.length > 0
      ? [{ vendorAccountId: vendor.id, vendorName: vendor.name, listings: vendorListings }]
      : [];
  });
}

async function upsertVendorCatalogMessages(args: {
  client: Client;
  projection: ProjectionRow;
  channel: TextChannel | null;
  catalogs: ActiveVendorCatalog[];
  currencyName: string;
  currencyEmoji: string;
}): Promise<void> {
  const existing = await readVendorCatalogRows(args.projection.id);
  if (!args.channel) {
    for (const row of existing) await removeVendorCatalogProjection(args.client, row);
    return;
  }

  const ordersEnabled = args.projection.directBuyEnabled
    && Boolean(args.projection.orderChannelId)
    && Boolean(args.projection.orderReadyChannelId);
  const keep = new Set<string>();

  for (const catalog of args.catalogs) {
    const row = existing.find(candidate => candidate.vendorAccountId === catalog.vendorAccountId) ?? null;
    const catalogProjectionId = row?.id ?? newCatalogProjectionId();
    const pages = chunk(catalog.listings, CATALOG_ITEMS_PER_MESSAGE);
    const currentPage = Math.max(0, Math.min(pages.length - 1, row?.currentPage ?? 0));
    const catalogPayload = {
      embeds: [vendorCatalogEmbed({
        vendorName: catalog.vendorName,
        listings: pages[currentPage],
        pageIndex: currentPage,
        totalPages: pages.length,
        currencyName: args.currencyName,
        currencyEmoji: args.currencyEmoji,
      })],
      components: vendorCatalogComponents({ catalogProjectionId, pageIndex: currentPage, totalPages: pages.length, ordersEnabled }),
      allowedMentions: { parse: [] as never[] },
    };
    const sameChannel = row?.channelId === args.channel.id;
    let catalogMessage = sameChannel && row ? await fetchManagedMessage(args.channel, row.catalogMessageId) : null;
    let createdCatalog = false;

    try {
      if (catalogMessage) await catalogMessage.edit(catalogPayload);
      else {
        catalogMessage = await args.channel.send(catalogPayload);
        createdCatalog = true;
      }

      // Bei Kanalwechsel oder deaktiviertem Bestellanker zuerst die bisher
      // persistierten Nachrichten entfernen. Erst danach darf die DB auf neue
      // IDs bzw. NULL zeigen. Schlägt die Löschung fehl, bleiben die alten IDs
      // für den nächsten Sync retryfähig und neu erzeugte Nachrichten werden
      // im catch wieder entfernt.
      if (row && row.channelId !== args.channel.id) {
        await deleteDiscordMessageRef(args.client, row.channelId, row.catalogMessageId);
        if (row.orderButtonMessageId) await deleteDiscordMessageRef(args.client, row.channelId, row.orderButtonMessageId);
      } else if (row && row.orderButtonMessageId) {
        await deleteDiscordMessageRef(args.client, row.channelId, row.orderButtonMessageId);
      }

      if (row) {
        await prisma.economyMarketVendorCatalogProjection.update({
          where: { id: row.id },
          data: {
            channelId: args.channel.id,
            catalogMessageId: catalogMessage.id,
            orderButtonMessageId: null,
            currentPage,
          },
        });
        keep.add(row.id);
      } else {
        const created = await prisma.economyMarketVendorCatalogProjection.create({
          data: {
            id: catalogProjectionId,
            projectionId: args.projection.id,
            guildId: args.projection.guildId,
            nitradoConnId: args.projection.nitradoConnId,
            vendorAccountId: catalog.vendorAccountId,
            channelId: args.channel.id,
            catalogMessageId: catalogMessage.id,
            orderButtonMessageId: null,
            currentPage,
          },
        });
        keep.add(created.id);
      }
    } catch (error) {
      if (createdCatalog && catalogMessage) await catalogMessage.delete().catch(() => undefined);
      throw error;
    }
  }

  for (const row of existing) {
    if (!keep.has(row.id)) await removeVendorCatalogProjection(args.client, row);
  }
}

async function removeDirectBuyMessages(args: { client: Client; existing: ProjectionMessageRow[] }): Promise<void> {
  const existingDirect = args.existing.filter(row => row.kind === 'DIRECT_BUY');
  for (const row of existingDirect) await removeProjectionMessage(args.client, row);
}

async function removeLegacyCatalogMessages(client: Client, projectionId: string): Promise<void> {
  const rows = await readMessageRows(projectionId);
  for (const row of rows) {
    if (row.kind === 'CATALOG' || row.kind === 'ORDER_BUTTON') await removeProjectionMessage(client, row);
  }
}

async function syncUnsafe(client: Client, guildId: GuildId, connId: NitradoConnId): Promise<MarketDiscordProjectionView | null> {
  const projection = await readProjection(guildId, connId);
  if (!projection) return null;

  try {
    const [listings, config, existing] = await Promise.all([
      listMarketListings(guildId, connId, false),
      getConfig(guildId, connId),
      readMessageRows(projection.id),
    ]);
    const catalogs = await loadActiveVendorCatalogs(guildId, connId, listings);
    const catalogChannel = projection.catalogChannelId
      ? await requireProjectionChannel(client, guildId, projection.catalogChannelId, 'Verkaufsliste-Kanal')
      : null;
    if (projection.directBuyEnabled && !projection.directBuyChannelId) throw new Error('Direktkauf ist aktiv, aber kein Direktkauf-Kanal ist konfiguriert.');

    await upsertVendorCatalogMessages({
      client,
      projection,
      channel: catalogChannel,
      catalogs,
      currencyName: config.currencyName,
      currencyEmoji: config.emoji,
    });
    await removeDirectBuyMessages({ client, existing });

    // Legacy erst entfernen, nachdem alle Händlerkataloge synchronisiert und
    // die alten Direct-Buy-Nachrichten erfolgreich bereinigt wurden.
    await removeLegacyCatalogMessages(client, projection.id);

    const updated = await prisma.economyMarketDiscordProjection.update({
      where: { id: projection.id },
      data: { lastSyncedAt: new Date(), lastSyncError: null },
    });
    return viewFor(updated);
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    const updated = await prisma.economyMarketDiscordProjection.update({
      where: { id: projection.id },
      data: { lastSyncError: message },
    });
    await viewFor(updated);
    throw error;
  }
}

export function syncMarketDiscordProjection(client: Client, guildId: GuildId, connId: NitradoConnId): Promise<MarketDiscordProjectionView | null> {
  const key = scopeKey(guildId, connId);
  const previous = syncInFlight.get(key) ?? Promise.resolve(null);
  const run = previous.catch(() => null).then(() => syncUnsafe(client, guildId, connId));
  syncInFlight.set(key, run);
  void run.finally(() => {
    if (syncInFlight.get(key) === run) syncInFlight.delete(key);
  }).catch(() => undefined);
  return run;
}

function parseCatalogPageCustomId(customId: string): { catalogProjectionId: string; page: number } {
  const parts = customId.split(':');
  if (parts.length !== 5 || parts[0] !== 'marketcat' || parts[1] !== 'v1' || parts[2] !== 'page') {
    throw new Error('Ungültige Katalog-Navigation. Bitte die aktuelle Verkaufsliste verwenden.');
  }
  const catalogProjectionId = parts[3];
  const pageRaw = parts[4];
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(catalogProjectionId)) {
    throw new Error('Ungültige Katalog-Navigation. Bitte die aktuelle Verkaufsliste verwenden.');
  }
  if (!/^(0|[1-9][0-9]{0,3})$/.test(pageRaw)) {
    throw new Error('Ungültige Katalogseite.');
  }
  const page = Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Ungültige Katalogseite.');
  return { catalogProjectionId, page };
}

async function replyCatalogError(interaction: ButtonInteraction, message: string): Promise<void> {
  const payload = {
    content: message,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] as never[] },
  } as const;
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => undefined);
  else await interaction.reply(payload).catch(() => undefined);
}

export async function handleMarketVendorCatalogPageButton(interaction: ButtonInteraction): Promise<void> {
  try {
    const parsed = parseCatalogPageCustomId(interaction.customId);
    if (!interaction.guildId || !interaction.channelId) throw new Error('Katalog-Navigation ist nur auf einem Discord-Server möglich.');
    if (!interaction.client.user || interaction.message.author.id !== interaction.client.user.id) {
      throw new Error('Diese Katalog-Nachricht wird nicht vom aktuellen V-Bot verwaltet.');
    }

    await interaction.deferUpdate();
    const initial = await prisma.economyMarketVendorCatalogProjection.findUnique({ where: { id: parsed.catalogProjectionId } });
    if (!initial) throw new Error('Dieser Händlerkatalog ist veraltet. Bitte die aktuelle Verkaufsliste verwenden.');
    if (initial.guildId !== interaction.guildId || initial.channelId !== interaction.channelId || initial.catalogMessageId !== interaction.message.id) {
      throw new Error('Dieser Händlerkatalog gehört nicht zu diesem Server, Kanal oder dieser Nachricht.');
    }

    const key = scopeKey(initial.guildId, initial.nitradoConnId);
    const previous = syncInFlight.get(key) ?? Promise.resolve(null);
    const run = previous.catch(() => null).then(async () => {
      const row = await prisma.economyMarketVendorCatalogProjection.findUnique({ where: { id: parsed.catalogProjectionId } });
      if (!row || row.guildId !== interaction.guildId || row.channelId !== interaction.channelId || row.catalogMessageId !== interaction.message.id) {
        throw new Error('Dieser Händlerkatalog ist nicht mehr aktuell.');
      }
      const [projection, vendor, listings, config] = await Promise.all([
        prisma.economyMarketDiscordProjection.findFirst({
          where: { id: row.projectionId, guildId: row.guildId, nitradoConnId: row.nitradoConnId },
        }),
        prisma.economyVirtualAccount.findFirst({
          where: {
            id: row.vendorAccountId,
            guildId: row.guildId,
            nitradoConnId: row.nitradoConnId,
            kind: 'MARKET_VENDOR',
            status: 'ACTIVE',
          },
          select: { id: true, name: true },
        }),
        listMarketListings(asGuildId(row.guildId), asNitradoConnId(row.nitradoConnId), false),
        getConfig(asGuildId(row.guildId), asNitradoConnId(row.nitradoConnId)),
      ]);
      if (!projection || projection.catalogChannelId !== row.channelId) {
        throw new Error('Dieser Händlerkatalog ist nicht mehr mit der aktiven Marktprojektion verknüpft.');
      }
      if (!vendor) throw new Error('Dieser Händler ist nicht mehr aktiv.');
      const vendorListings = listings.filter(listing => listing.vendorAccountId === row.vendorAccountId);
      if (vendorListings.length === 0) throw new Error('Dieser Händler hat aktuell keine aktiven Angebote.');
      const pages = chunk(vendorListings, CATALOG_ITEMS_PER_MESSAGE);
      if (parsed.page >= pages.length) throw new Error('Diese Katalogseite existiert nicht.');

      await interaction.message.edit({
        embeds: [vendorCatalogEmbed({
          vendorName: vendor.name,
          listings: pages[parsed.page],
          pageIndex: parsed.page,
          totalPages: pages.length,
          currencyName: config.currencyName,
          currencyEmoji: config.emoji,
        })],
        components: vendorCatalogComponents({
          catalogProjectionId: row.id,
          pageIndex: parsed.page,
          totalPages: pages.length,
          ordersEnabled: projection.directBuyEnabled
            && Boolean(projection.orderChannelId)
            && Boolean(projection.orderReadyChannelId),
        }),
        allowedMentions: { parse: [] },
      });
      const updated = await prisma.economyMarketVendorCatalogProjection.updateMany({
        where: {
          id: row.id,
          projectionId: row.projectionId,
          guildId: row.guildId,
          nitradoConnId: row.nitradoConnId,
          vendorAccountId: row.vendorAccountId,
          channelId: row.channelId,
          catalogMessageId: row.catalogMessageId,
        },
        data: { currentPage: parsed.page },
      });
      if (updated.count !== 1) throw new Error('Katalogseite konnte nicht sicher gespeichert werden.');
    });
    syncInFlight.set(key, run);
    void run.finally(() => {
      if (syncInFlight.get(key) === run) syncInFlight.delete(key);
    }).catch(() => undefined);
    await run;
  } catch (error) {
    await replyCatalogError(interaction, (error as Error).message);
  }
}

export async function configureMarketDiscordProjection(client: Client, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  orderChannelId: string | null;
  orderReadyChannelId: string | null;
}): Promise<MarketDiscordProjectionView> {
  if (args.catalogChannelId) await requireProjectionChannel(client, args.guildId, args.catalogChannelId, 'Verkaufsliste-Kanal');
  if (args.directBuyEnabled && !args.directBuyChannelId) throw new Error('Bei aktiviertem Direktkauf muss ein Direktkauf-Kanal gewählt werden.');
  if (args.directBuyChannelId) await requireProjectionChannel(client, args.guildId, args.directBuyChannelId, 'Direktkauf-Kanal');
  if (args.directBuyEnabled && (!args.orderChannelId || !args.orderReadyChannelId)) {
    throw new Error('Bei aktiviertem Direktkauf müssen Bestellungs- und Bestellung-bereit-Kanal gewählt werden.');
  }
  if (args.orderChannelId) await requireProjectionChannel(client, args.guildId, args.orderChannelId, 'Bestellungs-Kanal');
  if (args.orderReadyChannelId) await requireProjectionChannel(client, args.guildId, args.orderReadyChannelId, 'Bestellung-bereit-Kanal');

  await prisma.economyMarketDiscordProjection.upsert({
    where: { guildId_nitradoConnId: { guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId) } },
    create: {
      guildId: String(args.guildId),
      nitradoConnId: String(args.nitradoConnId),
      catalogChannelId: args.catalogChannelId,
      directBuyEnabled: args.directBuyEnabled,
      directBuyChannelId: args.directBuyEnabled ? args.directBuyChannelId : null,
      orderChannelId: args.directBuyEnabled ? args.orderChannelId : null,
      orderReadyChannelId: args.directBuyEnabled ? args.orderReadyChannelId : null,
    },
    update: {
      catalogChannelId: args.catalogChannelId,
      directBuyEnabled: args.directBuyEnabled,
      directBuyChannelId: args.directBuyEnabled ? args.directBuyChannelId : null,
      orderChannelId: args.directBuyEnabled ? args.orderChannelId : null,
      orderReadyChannelId: args.directBuyEnabled ? args.orderReadyChannelId : null,
    },
  });
  const synced = await syncMarketDiscordProjection(client, args.guildId, args.nitradoConnId);
  if (!synced) throw new Error('Schwarzmarkt-Discord-Projektion konnte nicht erstellt werden.');
  return synced;
}
