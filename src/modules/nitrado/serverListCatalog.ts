import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ButtonInteraction,
  type Client,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
  type TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger } from '../../utils/logger';
import { NitradoClient } from './nitradoClient';

const PAGE_SIZE = 20;
const SYNC_INTERVAL_MS = 3 * 60_000;
let timer: NodeJS.Timeout | null = null;

type CatalogKind = 'whitelist' | 'ban';
type CatalogRow = {
  guildId: string;
  nitradoConnId: string;
  whitelistCatalogChannelId: string | null;
  whitelistCatalogMessageId: string | null;
  banCatalogChannelId: string | null;
  banCatalogMessageId: string | null;
  nitradoConn: { encryptedToken: string; nitradoServerId: string | null; status: string };
};

function fields(kind: CatalogKind) {
  return kind === 'whitelist'
    ? { channel: 'whitelistCatalogChannelId' as const, message: 'whitelistCatalogMessageId' as const, title: 'Whitelist-Katalog', source: 'Nitrado whitelist' }
    : { channel: 'banCatalogChannelId' as const, message: 'banCatalogMessageId' as const, title: 'Bann-Katalog', source: 'Nitrado bans' };
}

function parseKind(value: string): CatalogKind | null {
  return value === 'whitelist' || value === 'ban' ? value : null;
}

async function entries(row: CatalogRow, kind: CatalogKind): Promise<string[]> {
  if (row.nitradoConn.status !== 'ACTIVE' || !row.nitradoConn.nitradoServerId) throw new Error('Nitrado-Verbindung ist nicht aktiv oder nicht vollständig gebunden.');
  const token = decrypt(row.nitradoConn.encryptedToken, config.security.encryptionKey);
  const client = new NitradoClient(token);
  const result = kind === 'whitelist'
    ? await client.getWhitelist(row.nitradoConn.nitradoServerId)
    : await client.getBanlist(row.nitradoConn.nitradoServerId);
  return result.map(item => item.identifier).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
}

function embed(kind: CatalogKind, names: string[], page: number, query?: string): EmbedBuilder {
  const meta = fields(kind);
  const pages = Math.max(1, Math.ceil(names.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const rows = names.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const intro = kind === 'whitelist'
    ? 'Aktuell freigeschaltete Spielernamen. Die Liste wird alle 3 Minuten direkt von Nitrado aktualisiert.'
    : 'Aktuell gebannte Spielernamen. Die Liste wird alle 3 Minuten direkt von Nitrado aktualisiert.';
  return new EmbedBuilder()
    .setColor(kind === 'whitelist' ? 0x57f287 : 0xed4245)
    .setTitle(kind === 'whitelist' ? '✅ Whitelist-Katalog' : '🔨 Bann-Katalog')
    .setDescription(rows.length ? `${intro}\n\n${rows.map((name, index) => `${safePage * PAGE_SIZE + index + 1}. \`${name.replace(/`/g, "'")}\``).join('\n')}` : `${intro}\n\n_Keine Einträge._`)
    .setFooter({ text: `${names.length} Einträge · Seite ${safePage + 1}/${pages} · ${meta.source}${query ? ` · Suche: ${query}` : ''}` })
    .setTimestamp();
}

function components(kind: CatalogKind, connId: string, page: number, total: number) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`listcat:${kind}:${connId}:${Math.max(0, page - 1)}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`listcat:search:${kind}:${connId}`).setLabel('Suchen').setEmoji('🔎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`listcat:${kind}:${connId}:${Math.min(total - 1, page + 1)}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= total - 1),
    new ButtonBuilder().setCustomId(`listcat:refresh:${kind}:${connId}`).setLabel('Aktualisieren').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  )];
}

async function catalogRow(guildId: string, connId: string): Promise<CatalogRow | null> {
  return prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    select: {
      guildId: true, nitradoConnId: true, whitelistCatalogChannelId: true, whitelistCatalogMessageId: true, banCatalogChannelId: true, banCatalogMessageId: true,
      nitradoConn: { select: { encryptedToken: true, nitradoServerId: true, status: true } },
    },
  }) as Promise<CatalogRow | null>;
}

async function publish(client: Client, row: CatalogRow, kind: CatalogKind, page = 0, query?: string): Promise<void> {
  const meta = fields(kind);
  const channelId = row[meta.channel];
  if (!channelId) return;
  const guild = client.guilds.cache.get(row.guildId);
  const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`${meta.title}-Kanal ist kein normaler Textkanal.`);
  const names = await entries(row, kind);
  const filtered = query ? names.filter(name => name.toLocaleLowerCase('de').includes(query.toLocaleLowerCase('de'))) : names;
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const payload = { embeds: [embed(kind, filtered, safePage, query)], components: components(kind, row.nitradoConnId, safePage, pages), allowedMentions: { parse: [] as never[] } };
  const messageId = row[meta.message];
  let message = messageId ? await (channel as TextChannel).messages.fetch(messageId).catch(() => null) : null;
  if (message) await message.edit(payload);
  else {
    message = await (channel as TextChannel).send(payload);
    await prisma.serverSettings.update({ where: { guildId_nitradoConnId: { guildId: row.guildId, nitradoConnId: row.nitradoConnId } }, data: { [meta.message]: message.id } });
  }
}

export async function syncServerListCatalog(client: Client, guildId: string, connId: string, kind: CatalogKind): Promise<void> {
  const row = await catalogRow(guildId, connId);
  if (row) await publish(client, row, kind);
}

async function syncConfiguredCatalogs(client: Client): Promise<void> {
  const rows = await prisma.serverSettings.findMany({
    where: { OR: [{ whitelistCatalogChannelId: { not: null } }, { banCatalogChannelId: { not: null } }] },
    select: { guildId: true, nitradoConnId: true },
  });
  const results = await Promise.allSettled(rows.flatMap(row => [
    syncServerListCatalog(client, row.guildId, row.nitradoConnId, 'whitelist'),
    syncServerListCatalog(client, row.guildId, row.nitradoConnId, 'ban'),
  ]));
  for (const result of results) {
    if (result.status === 'rejected') logger.warn(`Serverlisten-Katalog-Sync fehlgeschlagen: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }
}

export function startServerListCatalogSync(client: Client): void {
  if (timer) return;
  void syncConfiguredCatalogs(client).catch(error => logger.warn(`Serverlisten-Katalog-Startsync fehlgeschlagen: ${(error as Error).message}`));
  timer = setInterval(() => { void syncConfiguredCatalogs(client); }, SYNC_INTERVAL_MS);
  timer.unref?.();
}

export function stopServerListCatalogSync(): void { if (timer) clearInterval(timer); timer = null; }

export async function handleServerListCatalogButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const kind = parseKind(action === 'search' || action === 'refresh' ? parts[2] : action);
  const connId = action === 'search' || action === 'refresh' ? parts[3] : parts[2];
  if (!kind || !connId || !interaction.guildId) return;
  if (action === 'search') {
    const modal = new ModalBuilder().setCustomId(`listcat_search:${kind}:${connId}`).setTitle(`${fields(kind).title} durchsuchen`);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('query').setLabel('Spielername').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(128)));
    await interaction.showModal(modal);
    return;
  }
  const row = await catalogRow(interaction.guildId, connId);
  if (!row) return;
  await interaction.deferUpdate();
  const page = action === 'refresh' ? 0 : Number(parts[3] ?? '0');
  await publish(interaction.client, row, kind, Number.isInteger(page) && page >= 0 ? page : 0);
}

export async function handleServerListCatalogSearch(interaction: ModalSubmitInteraction): Promise<void> {
  const [, kindRaw, connId] = interaction.customId.split(':');
  const kind = parseKind(kindRaw);
  if (!kind || !connId || !interaction.guildId) return;
  const row = await catalogRow(interaction.guildId, connId);
  if (!row) return;
  const query = interaction.fields.getTextInputValue('query').trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const names = await entries(row, kind);
  const index = names.findIndex(name => name.toLocaleLowerCase('de').includes(query.toLocaleLowerCase('de')));
  await publish(interaction.client, row, kind, index < 0 ? 0 : Math.floor(index / PAGE_SIZE), query);
  await interaction.editReply(index < 0 ? 'Kein passender Eintrag gefunden.' : 'Katalog auf den passenden Eintrag gesetzt.');
}
