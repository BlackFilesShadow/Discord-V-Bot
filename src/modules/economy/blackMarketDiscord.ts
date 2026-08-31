import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
  type Message,
} from 'discord.js';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId } from '../../types/scope';
import { safeEmbedDescription, safeEmbedField } from '../../utils/embedSanitize';
import { getConfig } from './repository';
import { listMarketListings, type MarketListingView } from './blackMarket';
import { marketDirectBuyVersion } from './marketDirectBuyContract';

const CATALOG_ITEMS_PER_MESSAGE = 5;
const syncInFlight = new Map<string, Promise<MarketDiscordProjectionView | null>>();

type ProjectionRow = {
  id: string;
  guildId: string;
  nitradoConnId: string;
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
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

export interface MarketDiscordProjectionView {
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
  catalogMessageCount: number;
  directBuyMessageCount: number;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}

function scopeKey(guildId: GuildId, connId: NitradoConnId): string {
  return `${String(guildId)}:${String(connId)}`;
}

function chunk<T>(rows: T[], size: number): T[][] {
  if (rows.length === 0) return [[]];
  const pages: T[][] = [];
  for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
  return pages;
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

async function viewFor(row: ProjectionRow): Promise<MarketDiscordProjectionView> {
  const messages = await prisma.economyMarketDiscordMessage.findMany({
    where: { projectionId: row.id },
    select: { kind: true },
  });
  return {
    catalogChannelId: row.catalogChannelId,
    directBuyEnabled: row.directBuyEnabled,
    directBuyChannelId: row.directBuyChannelId,
    catalogMessageCount: messages.filter(message => message.kind === 'CATALOG').length,
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

/**
 * Unknown Message (10008) means the managed message is genuinely gone and may
 * be recreated. Permission, rate-limit and transient API errors are propagated
 * so the projection never creates a duplicate merely because Discord could not
 * be read at that moment.
 */
async function fetchManagedMessage(channel: TextChannel, messageId: string): Promise<Message | null> {
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (isUnknownDiscordResource(error, 10008)) return null;
    throw error;
  }
}

async function deleteDiscordMessage(client: Client, row: ProjectionMessageRow): Promise<void> {
  let channel;
  try {
    channel = await client.channels.fetch(row.channelId);
  } catch (error) {
    if (isUnknownDiscordResource(error, 10003)) return;
    throw error;
  }
  if (!channel) return;
  if (channel.type !== ChannelType.GuildText) {
    throw new Error(`Verwalteter Schwarzmarkt-Kanal ${row.channelId} ist kein Textkanal mehr.`);
  }
  const message = await fetchManagedMessage(channel as TextChannel, row.messageId);
  if (!message) return;
  try {
    await message.delete();
  } catch (error) {
    if (!isUnknownDiscordResource(error, 10008)) throw error;
  }
}

async function removeProjectionMessage(client: Client, row: ProjectionMessageRow): Promise<void> {
  // Keep database ownership when Discord deletion fails. Otherwise the next
  // sync would forget the still-existing message and create an unmanaged clone.
  await deleteDiscordMessage(client, row);
  await prisma.economyMarketDiscordMessage.deleteMany({ where: { id: row.id, projectionId: row.projectionId } });
}

function catalogEmbed(args: {
  listings: MarketListingView[];
  pageIndex: number;
  totalPages: number;
  currencyName: string;
  currencyEmoji: string;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x8b5cf6)
    .setTitle('🛒 Verkaufsliste')
    .setFooter({ text: `V-Bot · Schwarzmarkt · Live-Sync · Seite ${args.pageIndex + 1}/${args.totalPages}` })
    .setTimestamp();

  if (args.listings.length === 0) {
    return embed.setDescription('Aktuell sind keine aktiven Angebote vorhanden.');
  }

  embed.setDescription(`Aktive Angebote · Preise in **${safeEmbedDescription(args.currencyName)} ${args.currencyEmoji}**`);
  for (const listing of args.listings) {
    const description = listing.description ? `\n${safeEmbedField(listing.description, 500)}` : '';
    embed.addFields({
      name: safeEmbedField(listing.name, 250),
      value: `Preis: **${listing.price.toLocaleString('de-DE')} ${args.currencyEmoji}** · Max. pro Kauf: **${listing.maxPerPurchase}**${description}`,
      inline: false,
    });
  }
  return embed;
}

function directBuyEmbed(listing: MarketListingView, currencyName: string, currencyEmoji: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x22c55e)
    .setTitle(`🛍️ ${safeEmbedField(listing.name, 220)}`)
    .addFields(
      { name: 'Preis', value: `**${listing.price.toLocaleString('de-DE')} ${currencyEmoji}**`, inline: true },
      { name: 'Max. pro Kauf', value: `**${listing.maxPerPurchase}**`, inline: true },
      { name: 'Währung', value: safeEmbedField(`${currencyName} ${currencyEmoji}`, 200), inline: true },
    )
    .setFooter({ text: 'V-Bot · Direktkauf · Live-Sync' })
    .setTimestamp(listing.updatedAt);
  if (listing.description) embed.setDescription(safeEmbedDescription(listing.description));
  return embed;
}

function directBuyComponents(listing: MarketListingView) {
  const version = marketDirectBuyVersion(listing);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`marketbuy:w:${listing.id}:${version}`)
      .setLabel('Aus Wallet kaufen')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`marketbuy:b:${listing.id}:${version}`)
      .setLabel('Aus Bank kaufen')
      .setEmoji('🏦')
      .setStyle(ButtonStyle.Primary),
  )];
}

async function upsertCatalogMessages(args: {
  client: Client;
  projection: ProjectionRow;
  channel: TextChannel | null;
  listings: MarketListingView[];
  currencyName: string;
  currencyEmoji: string;
  existing: ProjectionMessageRow[];
}): Promise<void> {
  const existingCatalog = args.existing.filter(row => row.kind === 'CATALOG');
  if (!args.channel) {
    for (const row of existingCatalog) await removeProjectionMessage(args.client, row);
    return;
  }

  const pages = chunk(args.listings, CATALOG_ITEMS_PER_MESSAGE);
  const keep = new Set<string>();
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const payload = { embeds: [catalogEmbed({ listings: pages[pageIndex], pageIndex, totalPages: pages.length, currencyName: args.currencyName, currencyEmoji: args.currencyEmoji })], allowedMentions: { parse: [] as never[] } };
    const row = existingCatalog.find(candidate => candidate.pageIndex === pageIndex) ?? null;
    let message = row?.channelId === args.channel.id
      ? await fetchManagedMessage(args.channel, row.messageId)
      : null;

    if (row && row.channelId !== args.channel.id) await deleteDiscordMessage(args.client, row);
    if (message) await message.edit(payload);
    else message = await args.channel.send(payload);

    if (row) {
      await prisma.economyMarketDiscordMessage.update({
        where: { id: row.id },
        data: { channelId: args.channel.id, messageId: message.id },
      });
      keep.add(row.id);
    } else {
      const created = await prisma.economyMarketDiscordMessage.create({
        data: {
          projectionId: args.projection.id,
          guildId: args.projection.guildId,
          nitradoConnId: args.projection.nitradoConnId,
          kind: 'CATALOG',
          pageIndex,
          listingId: null,
          channelId: args.channel.id,
          messageId: message.id,
        },
      });
      keep.add(created.id);
    }
  }

  for (const row of existingCatalog) {
    if (!keep.has(row.id)) await removeProjectionMessage(args.client, row);
  }
}

async function upsertDirectBuyMessages(args: {
  client: Client;
  projection: ProjectionRow;
  channel: TextChannel | null;
  listings: MarketListingView[];
  currencyName: string;
  currencyEmoji: string;
  existing: ProjectionMessageRow[];
}): Promise<void> {
  const existingDirect = args.existing.filter(row => row.kind === 'DIRECT_BUY');
  if (!args.channel || !args.projection.directBuyEnabled) {
    for (const row of existingDirect) await removeProjectionMessage(args.client, row);
    return;
  }

  const keep = new Set<string>();
  for (const listing of args.listings) {
    const payload = {
      embeds: [directBuyEmbed(listing, args.currencyName, args.currencyEmoji)],
      components: directBuyComponents(listing),
      allowedMentions: { parse: [] as never[] },
    };
    const row = existingDirect.find(candidate => candidate.listingId === listing.id) ?? null;
    let message = row?.channelId === args.channel.id
      ? await fetchManagedMessage(args.channel, row.messageId)
      : null;

    if (row && row.channelId !== args.channel.id) await deleteDiscordMessage(args.client, row);
    if (message) await message.edit(payload);
    else message = await args.channel.send(payload);

    if (row) {
      await prisma.economyMarketDiscordMessage.update({
        where: { id: row.id },
        data: { channelId: args.channel.id, messageId: message.id },
      });
      keep.add(row.id);
    } else {
      const created = await prisma.economyMarketDiscordMessage.create({
        data: {
          projectionId: args.projection.id,
          guildId: args.projection.guildId,
          nitradoConnId: args.projection.nitradoConnId,
          kind: 'DIRECT_BUY',
          pageIndex: null,
          listingId: listing.id,
          channelId: args.channel.id,
          messageId: message.id,
        },
      });
      keep.add(created.id);
    }
  }

  for (const row of existingDirect) {
    if (!keep.has(row.id)) await removeProjectionMessage(args.client, row);
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
    const catalogChannel = projection.catalogChannelId
      ? await requireProjectionChannel(client, guildId, projection.catalogChannelId, 'Verkaufsliste-Kanal')
      : null;
    const directChannel = projection.directBuyEnabled && projection.directBuyChannelId
      ? await requireProjectionChannel(client, guildId, projection.directBuyChannelId, 'Direktkauf-Kanal')
      : null;
    if (projection.directBuyEnabled && !projection.directBuyChannelId) throw new Error('Direktkauf ist aktiv, aber kein Direktkauf-Kanal ist konfiguriert.');

    await upsertCatalogMessages({ client, projection, channel: catalogChannel, listings, currencyName: config.currencyName, currencyEmoji: config.emoji, existing });
    const afterCatalog = await readMessageRows(projection.id);
    await upsertDirectBuyMessages({ client, projection, channel: directChannel, listings, currencyName: config.currencyName, currencyEmoji: config.emoji, existing: afterCatalog });

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

/**
 * Immediate live sync with per-scope serialization. Parallel dashboard changes,
 * direct purchases and account mutations therefore cannot create duplicate
 * catalog/direct-buy messages or mix one listing's Discord projection with
 * another listing.
 */
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

export async function configureMarketDiscordProjection(client: Client, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  catalogChannelId: string | null;
  directBuyEnabled: boolean;
  directBuyChannelId: string | null;
}): Promise<MarketDiscordProjectionView> {
  if (args.catalogChannelId) await requireProjectionChannel(client, args.guildId, args.catalogChannelId, 'Verkaufsliste-Kanal');
  if (args.directBuyEnabled && !args.directBuyChannelId) throw new Error('Bei aktiviertem Direktkauf muss ein Direktkauf-Kanal gewählt werden.');
  if (args.directBuyChannelId) await requireProjectionChannel(client, args.guildId, args.directBuyChannelId, 'Direktkauf-Kanal');

  await prisma.economyMarketDiscordProjection.upsert({
    where: { guildId_nitradoConnId: { guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId) } },
    create: {
      guildId: String(args.guildId),
      nitradoConnId: String(args.nitradoConnId),
      catalogChannelId: args.catalogChannelId,
      directBuyEnabled: args.directBuyEnabled,
      directBuyChannelId: args.directBuyEnabled ? args.directBuyChannelId : null,
    },
    update: {
      catalogChannelId: args.catalogChannelId,
      directBuyEnabled: args.directBuyEnabled,
      directBuyChannelId: args.directBuyEnabled ? args.directBuyChannelId : null,
    },
  });
  const synced = await syncMarketDiscordProjection(client, args.guildId, args.nitradoConnId);
  if (!synced) throw new Error('Schwarzmarkt-Discord-Projektion konnte nicht erstellt werden.');
  return synced;
}
