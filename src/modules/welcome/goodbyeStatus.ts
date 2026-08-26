import { EmbedBuilder, type GuildTextBasedChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { safeEmbedField } from '../../utils/embedSanitize';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { identityHash } from '../linking/identity';

export type GoodbyeRemoteState =
  | 'PENDING'
  | 'RUNNING'
  | 'RETRY'
  | 'CONFIRMED'
  | 'NOT_PRESENT'
  | 'NOT_LINKED'
  | 'FAILED';

export interface GoodbyeServerStatus {
  nitradoConnId: string | null;
  serverAlias: string;
  playerNames: string[];
  state: GoodbyeRemoteState;
  confirmedAt?: string;
  error?: string;
}

export interface GoodbyeCleanupSnapshot {
  servers: GoodbyeServerStatus[];
}

export interface GoodbyeEmbedData {
  discordName: string;
  /** Native Discord-Mention; wird nur gerendert, wenn sie zuvor sicher aufgeloest wurde. */
  discordMention?: string;
  discordMentionResolved?: boolean;
  customMessage: string;
  /** Discord-Beitrittszeitpunkt dieser konkreten Guild-Mitgliedschaft. */
  joinedAt?: Date | null;
  leaveOccurredAt: Date;
  cleanupEnabled: boolean;
  cleanupSnapshot: GoodbyeCleanupSnapshot | null;
}

const TIME_ZONE = 'Europe/Berlin';
const DISCORD_SNOWFLAKE_ONLY_RE = /^\d{17,20}$/;
const DISCORD_MENTION_ONLY_RE = /^<@!?\d{17,20}>$/;
const DISCORD_MENTION_ANY_RE = /<@!?\d{17,20}>/g;
const DISCORD_SNOWFLAKE_ANY_RE = /(^|[^\d])(\d{17,20})(?=$|[^\d])/g;

/**
 * Sichtbare Goodbye-Texte duerfen niemals eine rohe Discord-Snowflake zeigen.
 * Das gilt auch fuer alte persistierte Namen, manuell gespeicherte Templates,
 * Cleanup-Fehlertexte und unerwartete Fallbacks.
 */
export function sanitizeGoodbyeVisibleText(
  value: string | null | undefined,
  fallback = 'Discord-Nutzer',
  maxLength = 1024,
): string {
  let text = String(value ?? '').normalize('NFKC').trim();
  if (!text) return fallback;
  text = text.replace(DISCORD_MENTION_ANY_RE, 'Discord-Nutzer');
  text = text.replace(DISCORD_SNOWFLAKE_ANY_RE, (_match, prefix: string) => `${prefix}Discord-Nutzer`);
  text = text.trim();
  if (!text || DISCORD_SNOWFLAKE_ONLY_RE.test(text) || DISCORD_MENTION_ONLY_RE.test(text)) return fallback;
  return safeEmbedField(text, maxLength);
}

function safeResolvedMention(value: string | undefined, resolved: boolean | undefined): string | null {
  if (!resolved || !value || !DISCORD_MENTION_ONLY_RE.test(value)) return null;
  return value.replace('<@!', '<@');
}

function readSnapshot(value: unknown): GoodbyeCleanupSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const servers = (value as { servers?: unknown }).servers;
  if (!Array.isArray(servers)) return null;
  return { servers: servers as GoodbyeServerStatus[] };
}

function statusLabel(state: GoodbyeRemoteState): string {
  switch (state) {
    case 'PENDING': return '🟡 Wartet auf Verarbeitung';
    case 'RUNNING': return '🟡 Entfernung läuft';
    case 'RETRY': return '🟠 Erneuter Versuch geplant';
    case 'CONFIRMED': return '🟢 Nicht mehr auf der Whitelist – remote bestätigt';
    case 'NOT_PRESENT': return '⚪ War nicht auf der Whitelist';
    case 'NOT_LINKED': return '⚪ Nicht eindeutig zugeordnet – keine Entfernung';
    case 'FAILED': return '🔴 Entfernung endgültig fehlgeschlagen';
  }
}

function embedColor(cleanupEnabled: boolean, snapshot: GoodbyeCleanupSnapshot | null): number {
  if (!cleanupEnabled) return 0x5865f2;
  const states = snapshot?.servers.map(server => server.state) ?? ['NOT_LINKED'];
  if (states.includes('FAILED')) return 0xdc2626;
  if (states.includes('RETRY')) return 0xf97316;
  if (states.includes('PENDING') || states.includes('RUNNING')) return 0xeab308;
  if (states.length > 0 && states.every(state => state === 'CONFIRMED')) return 0x16a34a;
  return 0x6b7280;
}

function formatDate(value: Date): string {
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'long',
    timeZone: TIME_ZONE,
  }).format(value);
}

function formatTime(value: Date): string {
  return `${new Intl.DateTimeFormat('de-DE', {
    timeStyle: 'medium',
    timeZone: TIME_ZONE,
  }).format(value)} Uhr`;
}

export function buildStructuredGoodbyeEmbed(data: GoodbyeEmbedData): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(embedColor(data.cleanupEnabled, data.cleanupSnapshot))
    .setTitle('👋 Bye Bye');

  const customMessage = sanitizeGoodbyeVisibleText(data.customMessage, '', 4000);
  if (customMessage) embed.setDescription(customMessage);

  const safeName = sanitizeGoodbyeVisibleText(data.discordName, 'Discord-Nutzer', 256);
  const mention = safeResolvedMention(data.discordMention, data.discordMentionResolved);
  const identityLine = mention ?? safeName;
  const joined = data.joinedAt ? formatDate(data.joinedAt) : 'Unbekannt';

  // Eine einzige, nicht-inline Detailgruppe verhindert das von Discord erzeugte
  // 3+2-Raster und bleibt auf Desktop/Mobile stabil ausgerichtet.
  embed
    .addFields({
      name: '👤 Mitglied',
      value: [
        `**Discord:** ${identityLine}`,
        '**Status:** Server verlassen',
        `**Beigetreten:** ${joined}`,
        `**Ausgetreten:** ${formatDate(data.leaveOccurredAt)} · ${formatTime(data.leaveOccurredAt)}`,
      ].join('\n'),
      inline: false,
    })
    .setTimestamp(data.leaveOccurredAt);

  if (!data.cleanupEnabled) return embed;
  const servers = data.cleanupSnapshot?.servers.length
    ? data.cleanupSnapshot.servers
    : [{ nitradoConnId: null, serverAlias: 'Keine eindeutige Serverzuordnung', playerNames: [], state: 'NOT_LINKED' as const }];
  const playerLines = servers.map(server => {
    const serverAlias = sanitizeGoodbyeVisibleText(server.serverAlias, 'DayZ-Server', 128);
    const players = server.playerNames.length > 0
      ? server.playerNames.map(player => sanitizeGoodbyeVisibleText(player, 'Unbekannter Spieler', 128)).join(', ')
      : 'Nicht eindeutig zugeordnet';
    return `**${serverAlias}:** ${sanitizeGoodbyeVisibleText(players, 'Nicht eindeutig zugeordnet', 512)}`;
  });
  const statusLines = servers.map(server => {
    const serverAlias = sanitizeGoodbyeVisibleText(server.serverAlias, 'DayZ-Server', 128);
    const confirmed = server.state === 'CONFIRMED' && server.confirmedAt
      ? ` · bestätigt ${formatDate(new Date(server.confirmedAt))}, ${formatTime(new Date(server.confirmedAt))}`
      : '';
    const error = server.state === 'FAILED' && server.error
      ? ` · ${sanitizeGoodbyeVisibleText(server.error, 'Remote-Fehler', 180)}`
      : '';
    return `**${serverAlias}:** ${statusLabel(server.state)}${confirmed}${error}`;
  });
  embed.addFields(
    { name: '🎮 Zugeordneter DayZ-Spieler', value: sanitizeGoodbyeVisibleText(playerLines.join('\n'), 'Nicht eindeutig zugeordnet', 1024), inline: false },
    { name: '🛡️ Whitelist-Status je Gameserver', value: sanitizeGoodbyeVisibleText(statusLines.join('\n'), 'Kein Status verfügbar', 1024), inline: false },
  );
  return embed;
}

export async function initialGoodbyeCleanupSnapshot(
  guildId: string,
  discordId: string,
): Promise<GoodbyeCleanupSnapshot> {
  const links = await prisma.gameIdentityLink.findMany({
    where: { guildId, userDiscordId: discordId, status: 'VERIFIED', identityHash: { not: null } },
    select: {
      nitradoConnId: true,
      identityHash: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  const servers: GoodbyeServerStatus[] = [];
  for (const link of links) {
    if (!link.identityHash) continue;
    const [sessions, whitelistEntries, connection] = await Promise.all([
      prisma.playerSession.findMany({
        where: { guildId, nitradoConnId: link.nitradoConnId },
        select: { gameId: true, playerName: true },
        orderBy: { connectedAt: 'desc' },
        take: 5000,
      }),
      prisma.whitelistEntry.findMany({
        where: { guildId, nitradoConnId: link.nitradoConnId, syncState: 'SYNCED' },
        select: { gameId: true },
      }),
      prisma.nitradoConnection.findFirst({
        where: { id: link.nitradoConnId, guildId },
        select: { alias: true },
      }),
    ]);
    const linkedSessionNames = new Set(sessions.flatMap(session =>
      identityHash(session.gameId, config.security.encryptionKey) === link.identityHash && session.playerName?.trim()
        ? [session.playerName.trim().toLocaleLowerCase('en-US')]
        : [],
    ));
    const names = Array.from(new Set(whitelistEntries.flatMap(entry =>
      linkedSessionNames.has(entry.gameId.trim().toLocaleLowerCase('en-US')) ? [entry.gameId.trim()] : [],
    ))).sort((a, b) => a.localeCompare(b, 'de-DE'));
    servers.push({
      nitradoConnId: link.nitradoConnId,
      serverAlias: connection?.alias || 'DayZ-Server',
      playerNames: names,
      state: names.length > 0 ? 'PENDING' : 'NOT_LINKED',
    });
  }
  return {
    servers: servers.length > 0
      ? servers
      : [{ nitradoConnId: null, serverAlias: 'Keine eindeutige Serverzuordnung', playerNames: [], state: 'NOT_LINKED' }],
  };
}

async function editPersistedGoodbye(cleanupRequestId: string): Promise<void> {
  const delivery = await prisma.goodbyeDelivery.findUnique({ where: { cleanupRequestId } });
  if (!delivery?.messageId) return;
  const client = tryGetDashboardClient();
  if (!client) return;
  const channel = await client.channels.fetch(delivery.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) return;
  const textChannel = channel as GuildTextBasedChannel;
  if (textChannel.guildId !== delivery.guildId) return;
  const message = await textChannel.messages.fetch(delivery.messageId).catch(() => null);
  if (!message) return;
  const resolvedUser = await client.users.fetch(delivery.discordId).catch(() => null);
  const resolvedName = resolvedUser?.globalName?.trim() || resolvedUser?.username?.trim() || delivery.discordName;
  await message.edit({
    embeds: [buildStructuredGoodbyeEmbed({
      discordName: resolvedName,
      discordMention: resolvedUser ? `<@${delivery.discordId}>` : undefined,
      discordMentionResolved: Boolean(resolvedUser),
      customMessage: delivery.customMessage,
      joinedAt: delivery.joinedAt,
      leaveOccurredAt: delivery.leaveOccurredAt,
      cleanupEnabled: delivery.cleanupEnabled,
      cleanupSnapshot: readSnapshot(delivery.cleanupSnapshot),
    })],
    allowedMentions: { parse: [] },
  });
}

export async function updateGoodbyeCleanupServers(
  cleanupRequestId: string,
  updates: Array<Pick<GoodbyeServerStatus, 'nitradoConnId' | 'state'> & Partial<GoodbyeServerStatus>>,
): Promise<void> {
  const delivery = await prisma.goodbyeDelivery.findUnique({ where: { cleanupRequestId } });
  if (!delivery) return;
  const snapshot = readSnapshot(delivery.cleanupSnapshot);
  if (!snapshot) return;
  for (const update of updates) {
    let server = snapshot.servers.find(row => row.nitradoConnId === update.nitradoConnId);
    if (!server && update.nitradoConnId) {
      const connection = await prisma.nitradoConnection.findFirst({
        where: { id: update.nitradoConnId, guildId: delivery.guildId },
        select: { alias: true },
      });
      server = {
        nitradoConnId: update.nitradoConnId,
        serverAlias: connection?.alias || 'DayZ-Server',
        playerNames: update.playerNames ?? [],
        state: update.state,
      };
      if (snapshot.servers.length === 1 && snapshot.servers[0].nitradoConnId === null) snapshot.servers = [];
      snapshot.servers.push(server);
    }
    if (!server) continue;
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) (server as unknown as Record<string, unknown>)[key] = value;
    }
    if (update.state !== 'FAILED') delete server.error;
    if (update.state !== 'CONFIRMED') delete server.confirmedAt;
  }
  await prisma.goodbyeDelivery.update({
    where: { id: delivery.id },
    data: { cleanupSnapshot: snapshot as unknown as Prisma.InputJsonObject, lastError: null },
  });
  await editPersistedGoodbye(cleanupRequestId).catch(async error => {
    await prisma.goodbyeDelivery.updateMany({
      where: { id: delivery.id },
      data: { lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Goodbye-Update fehlgeschlagen' },
    });
  });
}

export async function updateGoodbyeCleanupFailure(
  cleanupRequestId: string,
  state: 'RETRY' | 'FAILED',
  error: string,
): Promise<void> {
  const delivery = await prisma.goodbyeDelivery.findUnique({ where: { cleanupRequestId } });
  const snapshot = readSnapshot(delivery?.cleanupSnapshot);
  if (!delivery || !snapshot) return;
  const updates = snapshot.servers
    .filter(server => !['CONFIRMED', 'NOT_PRESENT', 'NOT_LINKED'].includes(server.state))
    .map(server => ({ nitradoConnId: server.nitradoConnId, state, error: state === 'FAILED' ? error.slice(0, 180) : undefined }));
  if (updates.length > 0) await updateGoodbyeCleanupServers(cleanupRequestId, updates);
}

/**
 * Restart-/Failover-Recovery fuer einen Prozessabbruch zwischen persistiertem
 * Delivery-Intent und Discord-Send. updatedAt ist der CAS-Lease: nur ein Worker
 * darf eine mindestens 60 Sekunden alte PENDING/FAILED-Zeile uebernehmen.
 */
export async function recoverPendingGoodbyeDeliveries(now: Date = new Date()): Promise<number> {
  const staleBefore = new Date(now.getTime() - 60_000);
  const rows = await prisma.goodbyeDelivery.findMany({
    where: {
      messageId: null,
      state: { in: ['PENDING', 'FAILED'] },
      updatedAt: { lte: staleBefore },
    },
    orderBy: { updatedAt: 'asc' },
    take: 10,
  });
  let recovered = 0;
  for (const row of rows) {
    const claimed = await prisma.goodbyeDelivery.updateMany({
      where: { id: row.id, messageId: null, state: row.state, updatedAt: row.updatedAt },
      data: { state: 'PENDING', lastError: 'Restart-Recovery: Discord-Zustellung wird erneut versucht.' },
    });
    if (claimed.count !== 1) continue;
    try {
      const client = tryGetDashboardClient();
      if (!client) throw new Error('Discord-Client nicht verfuegbar');
      const channel = await client.channels.fetch(row.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) throw new Error('Goodbye-Channel nicht verfuegbar');
      const textChannel = channel as GuildTextBasedChannel;
      if (textChannel.guildId !== row.guildId) throw new Error('Goodbye-Channel gehoert nicht zur Guild');
      const resolvedUser = await client.users.fetch(row.discordId).catch(() => null);
      const resolvedName = resolvedUser?.globalName?.trim() || resolvedUser?.username?.trim() || row.discordName;
      const message = await textChannel.send({
        embeds: [buildStructuredGoodbyeEmbed({
          discordName: resolvedName,
          discordMention: resolvedUser ? `<@${row.discordId}>` : undefined,
          discordMentionResolved: Boolean(resolvedUser),
          customMessage: row.customMessage,
          joinedAt: row.joinedAt,
          leaveOccurredAt: row.leaveOccurredAt,
          cleanupEnabled: row.cleanupEnabled,
          cleanupSnapshot: readSnapshot(row.cleanupSnapshot),
        })],
        allowedMentions: { parse: [] },
        nonce: row.id.slice(0, 25),
        enforceNonce: true,
      });
      await prisma.goodbyeDelivery.updateMany({
        where: { id: row.id, messageId: null, state: 'PENDING' },
        data: { messageId: message.id, state: 'SENT', lastError: null },
      });
      recovered++;
    } catch (error) {
      await prisma.goodbyeDelivery.updateMany({
        where: { id: row.id, messageId: null, state: 'PENDING' },
        data: {
          state: 'FAILED',
          lastError: error instanceof Error ? error.message.slice(0, 1000) : 'Goodbye-Recovery fehlgeschlagen',
        },
      });
    }
  }
  return recovered;
}
