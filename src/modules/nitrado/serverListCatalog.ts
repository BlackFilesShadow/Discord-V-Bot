import { randomUUID } from 'node:crypto';
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
import { vEmbed } from '../../utils/embedDesign';
import { NitradoClient } from './nitradoClient';

const PAGE_SIZE = 20;
const SYNC_INTERVAL_MS = 3 * 60_000;
const SEARCH_SESSION_TTL_MS = 5 * 60_000;
const MAX_SEARCH_SESSIONS = 500;
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
type CatalogState = {
  row: CatalogRow;
  names: string[];
  fetchedAt: number;
};
type CatalogSearchSession = {
  token: string;
  userId: string;
  guildId: string;
  connId: string;
  kind: CatalogKind;
  query: string;
  names: string[];
  expiresAt: number;
};

const catalogStates = new Map<string, CatalogState>();
const catalogReads = new Map<string, Promise<string[]>>();
const catalogSearchSessions = new Map<string, CatalogSearchSession>();

function fields(kind: CatalogKind) {
  return kind === 'whitelist'
    ? { channel: 'whitelistCatalogChannelId' as const, message: 'whitelistCatalogMessageId' as const, title: 'Whitelist-Katalog', source: 'Nitrado whitelist' }
    : { channel: 'banCatalogChannelId' as const, message: 'banCatalogMessageId' as const, title: 'Bann-Katalog', source: 'Nitrado bans' };
}

function parseKind(value: string): CatalogKind | null {
  return value === 'whitelist' || value === 'ban' ? value : null;
}

function stateKey(guildId: string, connId: string, kind: CatalogKind): string {
  return `${guildId}:${connId}:${kind}`;
}

function rowStateKey(row: CatalogRow, kind: CatalogKind): string {
  return stateKey(row.guildId, row.nitradoConnId, kind);
}

function cloneNames(names: string[]): string[] {
  return [...names];
}

function setCatalogState(row: CatalogRow, kind: CatalogKind, names: string[], fetchedAt = Date.now()): CatalogState {
  const state: CatalogState = { row: { ...row, nitradoConn: { ...row.nitradoConn } }, names: cloneNames(names), fetchedAt };
  catalogStates.set(rowStateKey(row, kind), state);
  return state;
}

function getCatalogState(guildId: string, connId: string, kind: CatalogKind): CatalogState | null {
  return catalogStates.get(stateKey(guildId, connId, kind)) ?? null;
}

function invalidateCatalogState(guildId: string, connId: string, kind: CatalogKind): void {
  catalogStates.delete(stateKey(guildId, connId, kind));
}

function pruneSearchSessions(now = Date.now()): void {
  for (const [token, session] of catalogSearchSessions) {
    if (session.expiresAt <= now) catalogSearchSessions.delete(token);
  }
  if (catalogSearchSessions.size <= MAX_SEARCH_SESSIONS) return;
  const oldest = [...catalogSearchSessions.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  for (const session of oldest.slice(0, catalogSearchSessions.size - MAX_SEARCH_SESSIONS)) {
    catalogSearchSessions.delete(session.token);
  }
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('de');
}

function filterAndRankNames(names: string[], query: string): string[] {
  const needle = normalizeSearch(query);
  return names
    .map(name => ({ name, normalized: normalizeSearch(name) }))
    .filter(row => row.normalized.includes(needle))
    .sort((a, b) => {
      const score = (value: string) => value === needle ? 0 : value.startsWith(needle) ? 1 : 2;
      return score(a.normalized) - score(b.normalized) || a.name.localeCompare(b.name, 'de');
    })
    .map(row => row.name);
}

async function liveEntries(row: CatalogRow, kind: CatalogKind): Promise<string[]> {
  if (row.nitradoConn.status !== 'ACTIVE' || !row.nitradoConn.nitradoServerId) {
    throw new Error('Nitrado-Verbindung ist nicht aktiv oder nicht vollständig gebunden.');
  }
  const token = decrypt(row.nitradoConn.encryptedToken, config.security.encryptionKey);
  const client = new NitradoClient(token);
  const result = kind === 'whitelist'
    ? await client.getWhitelist(row.nitradoConn.nitradoServerId)
    : await client.getBanlist(row.nitradoConn.nitradoServerId);
  return result.map(item => item.identifier).filter(Boolean).sort((a, b) => a.localeCompare(b, 'de'));
}

async function refreshEntries(row: CatalogRow, kind: CatalogKind): Promise<string[]> {
  const key = rowStateKey(row, kind);
  const activeRead = catalogReads.get(key);
  if (activeRead) return activeRead;

  const read = liveEntries(row, kind)
    .then(names => {
      setCatalogState(row, kind, names);
      return names;
    })
    .finally(() => catalogReads.delete(key));
  catalogReads.set(key, read);
  return read;
}

function embed(kind: CatalogKind, names: string[], page: number, query?: string): EmbedBuilder {
  const meta = fields(kind);
  const pages = Math.max(1, Math.ceil(names.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  const rows = names.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const intro = kind === 'whitelist'
    ? 'Aktuell freigeschaltete Spielernamen. Die Liste wird alle 3 Minuten direkt von Nitrado aktualisiert.'
    : 'Aktuell gebannte Spielernamen. Die Liste wird alle 3 Minuten direkt von Nitrado aktualisiert.';
  return vEmbed(kind === 'whitelist' ? 0x57f287 : 0xed4245)
    .setTitle(query
      ? `${kind === 'whitelist' ? '✅' : '🔨'} ${meta.title} · Suche`
      : kind === 'whitelist' ? '✅ Whitelist-Katalog' : '🔨 Bann-Katalog')
    .setDescription(rows.length
      ? `${intro}\n\n${rows.map((name, index) => `${safePage * PAGE_SIZE + index + 1}. \`${name.replace(/`/g, "'")}\``).join('\n')}`
      : `${intro}\n\n_Keine Einträge._`)
    .setFooter({ text: `${names.length} Einträge · Seite ${safePage + 1}/${pages} · ${meta.source}${query ? ` · Suche: ${query}` : ''}` })
    .setTimestamp();
}

function catalogComponents(kind: CatalogKind, connId: string, page: number, totalPages: number) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`listcat:${kind}:${connId}:${Math.max(0, page - 1)}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`listcat:search:${kind}:${connId}`).setLabel('Suchen').setEmoji('🔎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`listcat:${kind}:${connId}:${Math.min(totalPages - 1, page + 1)}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
    new ButtonBuilder().setCustomId(`listcat:refresh:${kind}:${connId}`).setLabel('Aktualisieren').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  )];
}

function searchComponents(token: string, page: number, totalPages: number) {
  if (totalPages <= 1) return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`listcat:searchpage:${token}:${Math.max(0, page - 1)}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId(`listcat:searchpage:${token}:${Math.min(totalPages - 1, page + 1)}`).setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  )];
}

function catalogPayload(row: CatalogRow, kind: CatalogKind, names: string[], page: number) {
  const pages = Math.max(1, Math.ceil(names.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  return {
    embeds: [embed(kind, names, safePage)],
    components: catalogComponents(kind, row.nitradoConnId, safePage, pages),
    allowedMentions: { parse: [] as never[] },
  };
}

function searchPayload(session: CatalogSearchSession, page: number) {
  const pages = Math.max(1, Math.ceil(session.names.length / PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, pages - 1));
  return {
    embeds: [embed(session.kind, session.names, safePage, session.query)],
    components: searchComponents(session.token, safePage, pages),
    allowedMentions: { parse: [] as never[] },
  };
}

async function catalogRow(guildId: string, connId: string): Promise<CatalogRow | null> {
  return prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId: connId } },
    select: {
      guildId: true,
      nitradoConnId: true,
      whitelistCatalogChannelId: true,
      whitelistCatalogMessageId: true,
      banCatalogChannelId: true,
      banCatalogMessageId: true,
      nitradoConn: { select: { encryptedToken: true, nitradoServerId: true, status: true } },
    },
  }) as Promise<CatalogRow | null>;
}

function isCurrentCatalogMessage(interaction: ButtonInteraction, row: CatalogRow, kind: CatalogKind): boolean {
  const meta = fields(kind);
  return Boolean(
    interaction.client.user
    && interaction.message.author.id === interaction.client.user.id
    && row[meta.channel]
    && row[meta.message]
    && interaction.channelId === row[meta.channel]
    && interaction.message.id === row[meta.message],
  );
}

async function publish(client: Client, row: CatalogRow, kind: CatalogKind, page = 0): Promise<void> {
  const meta = fields(kind);
  const channelId = row[meta.channel];
  if (!channelId) {
    invalidateCatalogState(row.guildId, row.nitradoConnId, kind);
    return;
  }

  const names = await refreshEntries(row, kind);
  const guild = client.guilds.cache.get(row.guildId);
  const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error(`${meta.title}-Kanal ist kein normaler Textkanal oder für V-Bot nicht erreichbar.`);

  const messageId = row[meta.message];
  let message = messageId ? await (channel as TextChannel).messages.fetch(messageId).catch(() => null) : null;
  const messagePayload = catalogPayload(row, kind, names, page);
  if (message) {
    await message.edit(messagePayload);
  } else {
    message = await (channel as TextChannel).send(messagePayload);
    await prisma.serverSettings.update({
      where: { guildId_nitradoConnId: { guildId: row.guildId, nitradoConnId: row.nitradoConnId } },
      data: { [meta.message]: message.id },
    });
    row[meta.message] = message.id;
  }
  setCatalogState(row, kind, names);
}

export async function syncServerListCatalog(client: Client, guildId: string, connId: string, kind: CatalogKind): Promise<void> {
  const row = await catalogRow(guildId, connId);
  if (!row) {
    invalidateCatalogState(guildId, connId, kind);
    return;
  }
  if (!row[fields(kind).channel]) {
    invalidateCatalogState(guildId, connId, kind);
    return;
  }
  await publish(client, row, kind, 0);
}

async function syncConfiguredCatalogs(client: Client): Promise<void> {
  // eslint-disable-next-line local/no-unscoped-prisma-query -- globaler Scheduler findet konfigurierte Kataloge; jeder folgende Read/Write bleibt exakt guild+connection-gescoppt.
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

export function stopServerListCatalogSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
  catalogStates.clear();
  catalogReads.clear();
  catalogSearchSessions.clear();
}

async function replyCatalogButtonError(interaction: ButtonInteraction, content: string): Promise<void> {
  const payload = { content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] as never[] } } as const;
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => undefined);
  else await interaction.reply(payload).catch(() => undefined);
}

async function handleSearchPageButton(interaction: ButtonInteraction, token: string, pageRaw: string): Promise<void> {
  pruneSearchSessions();
  const session = catalogSearchSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    catalogSearchSessions.delete(token);
    await replyCatalogButtonError(interaction, 'Diese Suche ist abgelaufen. Bitte im festen Katalog eine neue Suche starten.');
    return;
  }
  if (session.userId !== interaction.user.id || session.guildId !== interaction.guildId) {
    await replyCatalogButtonError(interaction, 'Diese Suchansicht gehört zu einer anderen Sitzung.');
    return;
  }
  const page = Number(pageRaw);
  if (!Number.isSafeInteger(page) || page < 0) {
    await replyCatalogButtonError(interaction, 'Ungültige Suchseite.');
    return;
  }
  session.expiresAt = Date.now() + SEARCH_SESSION_TTL_MS;
  await interaction.update(searchPayload(session, page));
}

export async function handleServerListCatalogButton(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[1];

  if (action === 'searchpage') {
    const token = parts[2] ?? '';
    const pageRaw = parts[3] ?? '';
    if (!token || !pageRaw) return;
    await handleSearchPageButton(interaction, token, pageRaw);
    return;
  }

  const kind = parseKind(action === 'search' || action === 'refresh' ? parts[2] : action);
  const connId = action === 'search' || action === 'refresh' ? parts[3] : parts[2];
  if (!kind || !connId || !interaction.guildId) return;

  if (action === 'search') {
    const state = getCatalogState(interaction.guildId, connId, kind);
    if (!state || !isCurrentCatalogMessage(interaction, state.row, kind)) {
      await replyCatalogButtonError(interaction, 'Dieser Katalog ist noch nicht bereit oder der Button ist veraltet. Bitte die aktuelle feste Katalognachricht verwenden.');
      return;
    }
    const anchorMessageId = interaction.message.id;
    const modal = new ModalBuilder().setCustomId(`listcat_search:${kind}:${connId}:${anchorMessageId}`).setTitle(`${fields(kind).title} durchsuchen`);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('query').setLabel('Spielername').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(128),
    ));
    await interaction.showModal(modal);
    return;
  }

  if (action === 'refresh') {
    await interaction.deferUpdate();
    try {
      let state = getCatalogState(interaction.guildId, connId, kind);
      let row = state?.row ?? null;
      if (!row) row = await catalogRow(interaction.guildId, connId);
      if (!row || !isCurrentCatalogMessage(interaction, row, kind)) {
        await replyCatalogButtonError(interaction, 'Dieser Katalog-Button ist nicht mehr aktuell. Bitte die feste Katalognachricht verwenden.');
        return;
      }
      const names = await refreshEntries(row, kind);
      state = setCatalogState(row, kind, names);
      await interaction.editReply(catalogPayload(state.row, kind, state.names, 0));
    } catch (error) {
      logger.warn(`${fields(kind).title}-Aktualisierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      await replyCatalogButtonError(interaction, 'Aktualisierung bei Nitrado fehlgeschlagen. Die bisherige Katalogansicht bleibt erhalten.');
    }
    return;
  }

  const state = getCatalogState(interaction.guildId, connId, kind);
  if (!state) {
    await replyCatalogButtonError(interaction, 'Der Katalog wird gerade initialisiert. Bitte kurz warten oder „Aktualisieren“ verwenden.');
    return;
  }
  if (!isCurrentCatalogMessage(interaction, state.row, kind)) {
    await replyCatalogButtonError(interaction, 'Dieser Katalog-Button ist nicht mehr aktuell. Bitte die feste Katalognachricht verwenden.');
    return;
  }
  const page = Number(parts[3] ?? '0');
  if (!Number.isSafeInteger(page) || page < 0) {
    await replyCatalogButtonError(interaction, 'Ungültige Katalogseite.');
    return;
  }

  // Hot path: RAM state -> one Discord interaction update. No Prisma, Nitrado,
  // channel.fetch or message.fetch is allowed for normal page navigation.
  await interaction.update(catalogPayload(state.row, kind, state.names, page));
}

export async function handleServerListCatalogSearch(interaction: ModalSubmitInteraction): Promise<void> {
  const [, kindRaw, connId, anchorMessageId] = interaction.customId.split(':');
  const kind = parseKind(kindRaw);
  if (!kind || !connId || !anchorMessageId || !interaction.guildId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const state = getCatalogState(interaction.guildId, connId, kind);
  const meta = fields(kind);
  if (!state || state.row[meta.message] !== anchorMessageId || state.row[meta.channel] !== interaction.channelId) {
    await interaction.editReply('Der Katalog wurde inzwischen neu aufgebaut. Bitte die Suche über die aktuelle feste Katalognachricht erneut starten.');
    return;
  }

  const query = interaction.fields.getTextInputValue('query').normalize('NFKC').trim();
  if (!query) {
    await interaction.editReply('Bitte einen Spielernamen eingeben.');
    return;
  }

  const filtered = filterAndRankNames(state.names, query);
  if (!filtered.length) {
    await interaction.editReply('Kein passender Eintrag gefunden.');
    return;
  }

  pruneSearchSessions();
  const token = randomUUID().replace(/-/g, '').slice(0, 20);
  const session: CatalogSearchSession = {
    token,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    connId,
    kind,
    query,
    names: filtered,
    expiresAt: Date.now() + SEARCH_SESSION_TTL_MS,
  };
  catalogSearchSessions.set(token, session);
  await interaction.editReply(searchPayload(session, 0));
}
