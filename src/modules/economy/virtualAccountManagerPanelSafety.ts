import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  PermissionFlagsBits,
  type TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import type { VirtualAccountRawDb } from './virtualAccounts';

export interface SafeManagerPanelRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
  messageId: string | null;
  updatedByDiscordId: string;
  previousEveryoneView: number;
}

interface ManagerAccessRow {
  channelId: string;
  userDiscordId: string;
  previousViewChannel: number;
  previousSendMessages: number;
  previousReadHistory: number;
}

type TriState = -1 | 0 | 1;

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

async function readPanel(guildId: GuildId, connId: NitradoConnId): Promise<SafeManagerPanelRow | null> {
  const rows = await rawDb().$queryRawUnsafe<SafeManagerPanelRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId", "previousEveryoneView" FROM "EconomyVirtualManagerPanel" WHERE "guildId"=$1 AND "nitradoConnId"=$2 LIMIT 1',
    String(guildId),
    String(connId),
  );
  return rows[0] ?? null;
}

async function readAccess(guildId: GuildId, connId: NitradoConnId): Promise<ManagerAccessRow[]> {
  return rawDb().$queryRawUnsafe<ManagerAccessRow[]>(
    'SELECT "channelId", "userDiscordId", "previousViewChannel", "previousSendMessages", "previousReadHistory" FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId),
    String(connId),
  );
}

function stateOf(overwrite: { allow: { has(flag: bigint): boolean }; deny: { has(flag: bigint): boolean } } | undefined, flag: bigint): TriState {
  if (!overwrite) return 0;
  if (overwrite.allow.has(flag)) return 1;
  if (overwrite.deny.has(flag)) return -1;
  return 0;
}

function permissionValue(state: number): boolean | null {
  if (state === 1) return true;
  if (state === -1) return false;
  return null;
}

function missingChannel(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : null;
  return code === 10003 || code === '10003';
}

async function fetchPanelChannel(client: Client, channelId: string): Promise<TextChannel | null> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error('Management-Channel konnte nicht aufgeloest werden.');
    if (channel.type !== ChannelType.GuildText) throw new Error('Management-Channel ist kein normaler Discord-Textkanal mehr.');
    return channel as TextChannel;
  } catch (error) {
    // Ist der Discord-Channel nachweislich geloescht, existieren auch seine
    // Overwrites nicht mehr und die Recovery-Daten koennen sicher verworfen werden.
    if (missingChannel(error)) return null;
    throw error;
  }
}

async function requirePanelPermissions(channel: TextChannel): Promise<void> {
  const me = channel.guild.members.me ?? await channel.guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('V-Bot-Mitglied konnte in der Guild nicht aufgeloest werden.');
  const perms = channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels,
  ];
  if (!perms?.has(required)) {
    throw new Error('V-Bot benoetigt im Management-Channel Lesen, Schreiben, Embed-Links und „Kanaele verwalten“.');
  }
}

async function restoreAccessStrict(channel: TextChannel, row: ManagerAccessRow, reason: string): Promise<void> {
  await channel.permissionOverwrites.edit(row.userDiscordId, {
    ViewChannel: permissionValue(row.previousViewChannel),
    SendMessages: permissionValue(row.previousSendMessages),
    ReadMessageHistory: permissionValue(row.previousReadHistory),
  }, { reason });
}

/**
 * Security-relevante Permission-Recovery ist strikt: erst wenn alle V-Bot-
 * Overwrites wieder im vorherigen Tri-State stehen, duerfen Tracking-Zeilen
 * geloescht werden. Ein Discord/API-Fehler behaelt daher bewusst Recovery-State.
 */
async function restorePanelStrict(client: Client, panel: SafeManagerPanelRow, tracked: ManagerAccessRow[]): Promise<void> {
  const channel = await fetchPanelChannel(client, panel.channelId);
  if (!channel) return;

  for (const row of tracked.filter(item => item.channelId === channel.id)) {
    await restoreAccessStrict(channel, row, 'V-Bot Kontoverwalter-Zugriff zurueckgesetzt');
  }
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
    ViewChannel: permissionValue(panel.previousEveryoneView),
  }, { reason: 'V-Bot Kontoverwalter-Kanal zurueckgesetzt' });

  if (panel.messageId) {
    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
    await message?.delete().catch(() => undefined);
  }
}

function managerPanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🏦 V-Bot · Virtuelle Kontoverwaltung')
    .setDescription([
      'Hier verwaltest du ausschliesslich die virtuellen Konten, fuer die du persoenlich freigeschaltet bist.',
      '',
      '**Auszahlung** · Konto → Discord-Spieler',
      '**Remove** · Betrag kontrolliert aus einem Konto entfernen',
      '**Pay / Balance** · Kontostand pruefen und Wallet ↔ Bank verschieben',
      '',
      'Nach der Aktion zeigt V-Bot dir nur deine zugewiesenen Konten zur Auswahl. Jede Mutation wird serverseitig erneut autorisiert und archiviert.',
    ].join('\n'))
    .setFooter({ text: 'V-Bot · Kontoverwalter · keine Discord-Rolle erforderlich' });
}

function managerPanelButtons(connId: NitradoConnId) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`vacct_mgr:payout:${connId}`).setLabel('Auszahlung').setEmoji('💸').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vacct_mgr:remove:${connId}`).setLabel('Remove').setEmoji('➖').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vacct_mgr:balance:${connId}`).setLabel('Pay / Balance').setEmoji('💳').setStyle(ButtonStyle.Secondary),
  )];
}

async function persistRecoveryPanel(args: {
  previous: SafeManagerPanelRow | null;
  guildId: GuildId;
  connId: NitradoConnId;
  channelId: string;
  messageId: string | null;
  updatedByDiscordId: UserDiscordId;
  previousEveryoneView: number;
  clearTracked: boolean;
}): Promise<void> {
  await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    if (args.clearTracked) {
      await raw.$executeRawUnsafe(
        'DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
        String(args.guildId),
        String(args.connId),
      );
    }
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualManagerPanel" ("id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId", "previousEveryoneView", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "updatedByDiscordId"=EXCLUDED."updatedByDiscordId", "previousEveryoneView"=EXCLUDED."previousEveryoneView", "updatedAt"=CURRENT_TIMESTAMP',
      args.previous?.id ?? randomUUID(),
      String(args.guildId),
      String(args.connId),
      args.channelId,
      args.messageId,
      String(args.updatedByDiscordId),
      args.previousEveryoneView,
    );
  });
}

export async function configureVirtualManagerPanelSafe(client: Client, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  channelId: string;
  updatedByDiscordId: UserDiscordId;
}): Promise<SafeManagerPanelRow> {
  const guild = client.guilds.cache.get(String(args.guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const fetched = await guild.channels.fetch(args.channelId).catch(() => null);
  if (!fetched || fetched.type !== ChannelType.GuildText) throw new Error('Kontoverwaltung benoetigt einen normalen Discord-Textkanal.');
  const channel = fetched as TextChannel;
  await requirePanelPermissions(channel);

  const previous = await readPanel(args.guildId, args.nitradoConnId);
  let tracked = await readAccess(args.guildId, args.nitradoConnId);
  const moving = Boolean(previous?.channelId && previous.channelId !== channel.id);

  if (previous && moving) {
    // Keine Recovery-Zeile wird geloescht, solange die Rueckgabe nicht vollstaendig
    // erfolgreich war. Das ist der entscheidende Unterschied zum Legacy-Pfad.
    await restorePanelStrict(client, previous, tracked);
  }

  const previousEveryoneView = previous && !moving
    ? previous.previousEveryoneView
    : stateOf(channel.permissionOverwrites.cache.get(guild.roles.everyone.id), PermissionFlagsBits.ViewChannel);
  const oldMessageId = previous && !moving ? previous.messageId : null;

  // Recovery-Zustand MUSS vor der ersten neuen Discord-Rechtemutation bestehen.
  await persistRecoveryPanel({
    previous,
    guildId: args.guildId,
    connId: args.nitradoConnId,
    channelId: channel.id,
    messageId: oldMessageId,
    updatedByDiscordId: args.updatedByDiscordId,
    previousEveryoneView,
    clearTracked: moving,
  });
  if (moving) tracked = [];

  await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason: 'V-Bot Kontoverwalter-Kanal' });

  const managerRows = await rawDb().$queryRawUnsafe<Array<{ userDiscordId: string }>>(
    'SELECT DISTINCT "userDiscordId" FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
  );
  const desired = new Set(managerRows.map(row => row.userDiscordId));
  const trackedMap = new Map(tracked.filter(row => row.channelId === channel.id).map(row => [row.userDiscordId, row]));

  for (const row of trackedMap.values()) {
    if (desired.has(row.userDiscordId)) continue;
    await restoreAccessStrict(channel, row, 'V-Bot Kontoverwalter entfernt');
    await rawDb().$executeRawUnsafe(
      'DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
      String(args.guildId),
      String(args.nitradoConnId),
      row.userDiscordId,
    );
  }

  for (const userId of desired) {
    const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot) continue;

    if (!trackedMap.has(userId)) {
      const overwrite = channel.permissionOverwrites.cache.get(userId);
      await rawDb().$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualManagerPanelAccess" ("guildId", "nitradoConnId", "channelId", "userDiscordId", "previousViewChannel", "previousSendMessages", "previousReadHistory", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
        String(args.guildId),
        String(args.nitradoConnId),
        channel.id,
        userId,
        stateOf(overwrite, PermissionFlagsBits.ViewChannel),
        stateOf(overwrite, PermissionFlagsBits.SendMessages),
        stateOf(overwrite, PermissionFlagsBits.ReadMessageHistory),
      );
    }

    // Tracking ist bereits persistent, bevor der Allow-Overwrite geschrieben wird.
    await channel.permissionOverwrites.edit(userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: 'V-Bot Kontoverwalter' });
  }

  let message = oldMessageId ? await channel.messages.fetch(oldMessageId).catch(() => null) : null;
  if (message) {
    await message.edit({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });
  } else {
    message = await channel.send({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });
  }

  await rawDb().$executeRawUnsafe(
    'UPDATE "EconomyVirtualManagerPanel" SET "messageId"=$3, "updatedByDiscordId"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId),
    String(args.nitradoConnId),
    message.id,
    String(args.updatedByDiscordId),
  );
  const persisted = await readPanel(args.guildId, args.nitradoConnId);
  if (!persisted) throw new Error('Management-Panel konnte nach der Synchronisierung nicht gelesen werden.');
  return persisted;
}

export async function disableVirtualManagerPanelSafe(client: Client, guildId: GuildId, connId: NitradoConnId): Promise<void> {
  const panel = await readPanel(guildId, connId);
  if (!panel) return;
  const tracked = await readAccess(guildId, connId);
  await restorePanelStrict(client, panel, tracked);
  await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    await raw.$executeRawUnsafe(
      'DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(guildId), String(connId),
    );
    await raw.$executeRawUnsafe(
      'DELETE FROM "EconomyVirtualManagerPanel" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(guildId), String(connId),
    );
  });
}

export async function refreshConfiguredVirtualManagerPanelSafe(client: Client, guildId: GuildId, connId: NitradoConnId, updatedByDiscordId: UserDiscordId): Promise<void> {
  const panel = await readPanel(guildId, connId);
  if (!panel) return;
  await configureVirtualManagerPanelSafe(client, {
    guildId,
    nitradoConnId: connId,
    channelId: panel.channelId,
    updatedByDiscordId,
  });
}

export async function getVirtualManagerPanelSafe(guildId: GuildId, connId: NitradoConnId): Promise<SafeManagerPanelRow | null> {
  return readPanel(guildId, connId);
}
