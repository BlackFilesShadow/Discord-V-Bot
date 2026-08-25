import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { safeEmbedDescription, safeEmbedField } from '../../utils/embedSanitize';
import { getVirtualAccountById, type EconomyPocket, type VirtualAccountRawDb } from './virtualAccounts';
import { getVirtualAccountMetadata } from './virtualAccountMetadata';
import {
  ensureVirtualAccountFinance,
  listVirtualAccountManagers,
  type VirtualAccountFinance,
  type VirtualAccountTextStyle,
} from './virtualAccountFinance';

interface ProjectionRow {
  accountId: string;
  guildId: string;
  nitradoConnId: string;
  channelId: string | null;
  messageId: string | null;
  archiveThreadId: string | null;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
}

interface ManagerPanelRow {
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

function rawDb(): VirtualAccountRawDb {
  return prisma as unknown as VirtualAccountRawDb;
}

function fmt(value: bigint): string {
  return value.toLocaleString('de-DE');
}

function styledDescription(value: string | null, style: VirtualAccountTextStyle): string | null {
  if (!value) return null;
  const safe = safeEmbedDescription(value);
  if (style === 'BOLD') return `**${safe}**`;
  if (style === 'ITALIC') return `*${safe}*`;
  if (style === 'BOLD_ITALIC') return `***${safe}***`;
  return safe;
}

function statusLabel(status: string): string {
  if (status === 'ACTIVE') return '🟢 Aktiv';
  if (status === 'EXPIRED') return '🟡 Abgelaufen';
  return '⚫ Archiviert';
}

function typeLabel(kind: string, finance: VirtualAccountFinance): string {
  if (finance.accountPurpose === 'BANK_TREASURY') return 'Serverbank';
  if (kind === 'LOTTERY_POT') return 'Lotterie';
  if (kind === 'MARKET_VENDOR') return 'Schwarzmarkt';
  return 'Virtuelles Konto';
}

export async function buildVirtualAccountEmbed(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<EmbedBuilder> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const [metadata, finance, managers] = await Promise.all([
    getVirtualAccountMetadata(guildId, connId, accountId),
    ensureVirtualAccountFinance(guildId, connId, accountId),
    listVirtualAccountManagers(guildId, connId, accountId),
  ]);
  const total = account.balance + finance.bankBalance;
  const managerText = managers.length > 0
    ? managers.map(manager => `<@${manager.userDiscordId}>`).join(' · ')
    : 'Nicht zugewiesen';
  const embed = new EmbedBuilder()
    .setColor(account.status === 'ACTIVE' ? 0x2ecc71 : account.status === 'EXPIRED' ? 0xf1c40f : 0x6b7280)
    .setTitle(`${finance.accountEmoji} ${safeEmbedField(account.name, 200)}`)
    .addFields(
      { name: 'Wallet', value: `**${fmt(account.balance)}** ${finance.currencyEmoji}`, inline: true },
      { name: 'Bankkonto', value: `**${fmt(finance.bankBalance)}** ${finance.currencyEmoji}`, inline: true },
      { name: 'Gesamt', value: `**${fmt(total)}** ${finance.currencyEmoji}`, inline: true },
      { name: 'Währung', value: safeEmbedField(`${finance.currencyName} ${finance.currencyEmoji}`, 200), inline: true },
      { name: 'Status', value: statusLabel(account.status), inline: true },
      { name: 'Typ', value: typeLabel(account.kind, finance), inline: true },
      { name: 'Kontoverwalter', value: safeEmbedField(managerText, 1024), inline: false },
    )
    .setFooter({ text: 'V-Bot · Virtuelles Konto · Live-Sync' })
    .setTimestamp(account.updatedAt);
  const description = styledDescription(metadata?.description ?? null, finance.textStyle);
  if (description) embed.setDescription(description);
  if (finance.bannerUrl) embed.setImage(finance.bannerUrl);
  return embed;
}

export function buildVirtualAccountButtons(args: { accountId: string; active: boolean; acceptsDeposits: boolean; kind: string }) {
  if (!args.active || !args.acceptsDeposits || args.kind !== 'CUSTOM') return [];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`vacct:deposit:${args.accountId}`)
      .setLabel('Einzahlen')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Success),
  )];
}

async function readProjection(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<ProjectionRow | null> {
  const rows = await rawDb().$queryRawUnsafe<ProjectionRow[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "channelId", "messageId", "archiveThreadId", "lastSyncedAt", "lastSyncError" FROM "EconomyVirtualAccountProjection" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    accountId, String(guildId), String(connId),
  );
  return rows[0] ?? null;
}

async function writeProjection(args: {
  guildId: GuildId;
  connId: NitradoConnId;
  accountId: string;
  channelId: string | null;
  messageId: string | null;
  archiveThreadId: string | null;
  error?: string | null;
}): Promise<void> {
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountProjection" ("accountId", "guildId", "nitradoConnId", "channelId", "messageId", "archiveThreadId", "lastSyncedAt", "lastSyncError", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "archiveThreadId"=EXCLUDED."archiveThreadId", "lastSyncedAt"=EXCLUDED."lastSyncedAt", "lastSyncError"=EXCLUDED."lastSyncError", "updatedAt"=CURRENT_TIMESTAMP',
    args.accountId,
    String(args.guildId),
    String(args.connId),
    args.channelId,
    args.messageId,
    args.archiveThreadId,
    args.error ? null : new Date(),
    args.error ? args.error.slice(0, 500) : null,
  );
}

function threadName(name: string): string {
  const clean = name.normalize('NFKC').replace(/[\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ');
  return `Archiv · ${clean}`.slice(0, 100) || 'Archiv · Virtuelles Konto';
}

async function retireProjection(client: Client, projection: ProjectionRow | null): Promise<void> {
  if (!projection) return;
  if (projection.messageId && projection.channelId) {
    const channel = await client.channels.fetch(projection.channelId).catch(() => null);
    if (channel?.isTextBased() && 'messages' in channel) {
      const message = await (channel as TextChannel).messages.fetch(projection.messageId).catch(() => null);
      await message?.delete().catch(() => undefined);
    }
  }
  if (projection.archiveThreadId) {
    const thread = await client.channels.fetch(projection.archiveThreadId).catch(() => null);
    if (thread?.isThread()) {
      await thread.setArchived(true, 'V-Bot Kontoprojektion verschoben/deaktiviert').catch(() => undefined);
    }
  }
}

async function requireProjectionPermissions(channel: TextChannel): Promise<void> {
  const guild = channel.guild;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('V-Bot-Mitglied konnte in der Guild nicht aufgelöst werden.');
  const perms = channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ];
  if (!perms?.has(required)) {
    throw new Error('V-Bot benötigt im Konto-Channel Lesen, Schreiben, Embed-Links sowie öffentliche Threads inkl. Thread-Nachrichten.');
  }
}

/** Discord is only a projection. Balance changes are committed before this runs. */
export async function syncVirtualAccountProjection(client: Client, guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<ProjectionRow | null> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const metadata = await getVirtualAccountMetadata(guildId, connId, accountId);
  const previous = await readProjection(guildId, connId, accountId);

  if (!metadata?.channelId) {
    await retireProjection(client, previous);
    await writeProjection({ guildId, connId, accountId, channelId: null, messageId: null, archiveThreadId: null });
    return null;
  }

  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const channel = await guild.channels.fetch(metadata.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Konto-Integration benötigt einen normalen Discord-Textkanal.');
  await requireProjectionPermissions(channel);

  let message = previous?.channelId === channel.id && previous.messageId
    ? await channel.messages.fetch(previous.messageId).catch(() => null)
    : null;

  try {
    if (previous?.channelId && previous.channelId !== channel.id) {
      await retireProjection(client, previous);
      message = null;
    }

    const embed = await buildVirtualAccountEmbed(guildId, connId, accountId);
    const components = buildVirtualAccountButtons({
      accountId,
      active: account.status === 'ACTIVE',
      acceptsDeposits: account.acceptUserTransfers,
      kind: account.kind,
    });
    if (message) {
      await message.edit({ embeds: [embed], components, allowedMentions: { parse: [] } });
    } else {
      message = await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
    }

    let archiveThreadId = previous?.channelId === channel.id ? previous.archiveThreadId : null;
    const existingThread = archiveThreadId ? await guild.channels.fetch(archiveThreadId).catch(() => null) : null;
    if (!existingThread || !existingThread.isThread()) {
      const thread = await message.startThread({
        name: threadName(account.name),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: 'V-Bot Transaktionsarchiv für virtuelles Konto',
      });
      archiveThreadId = thread.id;
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('📚 Transaktionsarchiv gestartet')
          .setDescription(`Alle bestätigten Geldbewegungen für **${safeEmbedDescription(account.name)}** werden hier protokolliert.`)
          .setTimestamp()],
        allowedMentions: { parse: [] },
      });
    } else if (existingThread.archived) {
      await existingThread.setArchived(false, 'V-Bot Transaktionsarchiv reaktiviert').catch(() => undefined);
    }

    await writeProjection({ guildId, connId, accountId, channelId: channel.id, messageId: message.id, archiveThreadId });
    return await readProjection(guildId, connId, accountId);
  } catch (error) {
    await writeProjection({
      guildId,
      connId,
      accountId,
      channelId: channel.id,
      messageId: message?.id ?? previous?.messageId ?? null,
      archiveThreadId: previous?.archiveThreadId ?? null,
      error: (error as Error).message,
    });
    throw error;
  }
}

export async function postVirtualAccountArchive(client: Client, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  title: string;
  actorDiscordId?: UserDiscordId | null;
  targetDiscordId?: UserDiscordId | null;
  amount: bigint;
  pocket?: EconomyPocket | null;
  status?: string;
  reason?: string | null;
}): Promise<void> {
  let projection = await readProjection(args.guildId, args.nitradoConnId, args.accountId);
  let thread = projection?.archiveThreadId
    ? await client.channels.fetch(projection.archiveThreadId).catch(() => null)
    : null;
  if (!thread || !thread.isThread()) {
    projection = await syncVirtualAccountProjection(client, args.guildId, args.nitradoConnId, args.accountId);
    thread = projection?.archiveThreadId
      ? await client.channels.fetch(projection.archiveThreadId).catch(() => null)
      : null;
  }
  if (!thread || !thread.isThread()) throw new Error('Transaktionsarchiv ist nicht konfiguriert oder nicht erreichbar.');
  if (thread.archived) await thread.setArchived(false, 'V-Bot Transaktionsarchiv für Buchung reaktiviert').catch(() => undefined);

  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const fields = [
    { name: 'Konto', value: safeEmbedField(`${finance.accountEmoji} ${account.name}`, 256), inline: false },
    ...(args.actorDiscordId ? [{ name: 'User / Ausgeführt von', value: `<@${args.actorDiscordId}>`, inline: true }] : []),
    ...(args.targetDiscordId ? [{ name: 'Empfänger', value: `<@${args.targetDiscordId}>`, inline: true }] : []),
    { name: 'Betrag', value: `**${fmt(args.amount)}** ${finance.currencyEmoji}`, inline: true },
    ...(args.pocket ? [{ name: 'Pocket', value: args.pocket === 'WALLET' ? 'Wallet' : 'Bankkonto', inline: true }] : []),
    { name: 'Status', value: args.status ?? '✅ Akzeptiert', inline: true },
    ...(args.reason ? [{ name: 'Grund', value: safeEmbedField(args.reason, 1024), inline: false }] : []),
    { name: 'Datum / Uhrzeit', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
  ];
  await thread.send({
    embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle(args.title).addFields(fields).setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

function managerPanelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🏦 V-Bot · Virtuelle Kontoverwaltung')
    .setDescription([
      'Hier verwaltest du ausschließlich die virtuellen Konten, für die du persönlich freigeschaltet bist.',
      '',
      '**Auszahlung** · Konto → Discord-Spieler',
      '**Remove** · Betrag kontrolliert aus einem Konto entfernen',
      '**Pay / Balance** · Kontostand prüfen und Wallet ↔ Bank verschieben',
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

async function readManagerPanel(guildId: GuildId, connId: NitradoConnId): Promise<ManagerPanelRow | null> {
  const rows = await rawDb().$queryRawUnsafe<ManagerPanelRow[]>(
    'SELECT "id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId", "previousEveryoneView" FROM "EconomyVirtualManagerPanel" WHERE "guildId"=$1 AND "nitradoConnId"=$2 LIMIT 1',
    String(guildId), String(connId),
  );
  return rows[0] ?? null;
}

async function readManagerAccess(guildId: GuildId, connId: NitradoConnId): Promise<ManagerAccessRow[]> {
  return rawDb().$queryRawUnsafe<ManagerAccessRow[]>(
    'SELECT "channelId", "userDiscordId", "previousViewChannel", "previousSendMessages", "previousReadHistory" FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(guildId), String(connId),
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

async function restoreTrackedManagerAccess(channel: TextChannel, row: ManagerAccessRow, reason: string): Promise<void> {
  await channel.permissionOverwrites.edit(row.userDiscordId, {
    ViewChannel: permissionValue(row.previousViewChannel),
    SendMessages: permissionValue(row.previousSendMessages),
    ReadMessageHistory: permissionValue(row.previousReadHistory),
  }, { reason }).catch(() => undefined);
}

async function restorePanelChannel(client: Client, panel: ManagerPanelRow, tracked: ManagerAccessRow[]): Promise<void> {
  const channel = await client.channels.fetch(panel.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) return;
  for (const row of tracked.filter(item => item.channelId === channel.id)) {
    await restoreTrackedManagerAccess(channel, row, 'V-Bot Kontoverwalter-Zugriff zurückgesetzt');
  }
  await channel.permissionOverwrites.edit(channel.guild.roles.everyone.id, {
    ViewChannel: permissionValue(panel.previousEveryoneView),
  }, { reason: 'V-Bot Kontoverwalter-Kanal zurückgesetzt' }).catch(() => undefined);
  if (panel.messageId) {
    const message = await channel.messages.fetch(panel.messageId).catch(() => null);
    await message?.delete().catch(() => undefined);
  }
}

async function requireManagerPanelPermissions(channel: TextChannel): Promise<void> {
  const guild = channel.guild;
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) throw new Error('V-Bot-Mitglied konnte in der Guild nicht aufgelöst werden.');
  const perms = channel.permissionsFor(me);
  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ManageChannels,
  ];
  if (!perms?.has(required)) {
    throw new Error('V-Bot benötigt im Management-Channel Lesen, Schreiben, Embed-Links und „Kanäle verwalten“.');
  }
}

/**
 * Only ViewChannel/SendMessages/ReadMessageHistory are owned by V-Bot for
 * manager users. Their previous tri-state is persisted and restored exactly.
 */
export async function configureVirtualManagerPanel(client: Client, args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  channelId: string;
  updatedByDiscordId: UserDiscordId;
}): Promise<ManagerPanelRow> {
  const guild = client.guilds.cache.get(String(args.guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const fetched = await guild.channels.fetch(args.channelId).catch(() => null);
  if (!fetched || fetched.type !== ChannelType.GuildText) throw new Error('Kontoverwaltung benötigt einen normalen Discord-Textkanal.');
  const channel = fetched as TextChannel;
  await requireManagerPanelPermissions(channel);

  const previous = await readManagerPanel(args.guildId, args.nitradoConnId);
  let tracked = await readManagerAccess(args.guildId, args.nitradoConnId);
  let previousEveryoneView = previous?.channelId === channel.id
    ? previous.previousEveryoneView
    : stateOf(channel.permissionOverwrites.cache.get(guild.roles.everyone.id), PermissionFlagsBits.ViewChannel);

  if (previous?.channelId && previous.channelId !== channel.id) {
    await restorePanelChannel(client, previous, tracked);
    await rawDb().$executeRawUnsafe(
      'DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
      String(args.guildId), String(args.nitradoConnId),
    );
    tracked = [];
  }

  await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason: 'V-Bot Kontoverwalter-Kanal' });

  const managers = await rawDb().$queryRawUnsafe<Array<{ userDiscordId: string }>>(
    'SELECT DISTINCT "userDiscordId" FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2',
    String(args.guildId), String(args.nitradoConnId),
  );
  const desired = new Set(managers.map(row => row.userDiscordId));
  const trackedMap = new Map(tracked.filter(item => item.channelId === channel.id).map(item => [item.userDiscordId, item]));

  for (const row of trackedMap.values()) {
    if (!desired.has(row.userDiscordId)) {
      await restoreTrackedManagerAccess(channel, row, 'V-Bot Kontoverwalter entfernt');
      await rawDb().$executeRawUnsafe(
        'DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
        String(args.guildId), String(args.nitradoConnId), row.userDiscordId,
      );
    }
  }

  for (const user of desired) {
    const member = guild.members.cache.get(user) ?? await guild.members.fetch(user).catch(() => null);
    if (!member || member.user.bot) continue;
    if (!trackedMap.has(user)) {
      const overwrite = channel.permissionOverwrites.cache.get(user);
      const beforeView = stateOf(overwrite, PermissionFlagsBits.ViewChannel);
      const beforeSend = stateOf(overwrite, PermissionFlagsBits.SendMessages);
      const beforeHistory = stateOf(overwrite, PermissionFlagsBits.ReadMessageHistory);
      await rawDb().$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualManagerPanelAccess" ("guildId", "nitradoConnId", "channelId", "userDiscordId", "previousViewChannel", "previousSendMessages", "previousReadHistory", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
        String(args.guildId), String(args.nitradoConnId), channel.id, user, beforeView, beforeSend, beforeHistory,
      );
    }
    await channel.permissionOverwrites.edit(user, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: 'V-Bot Kontoverwalter' });
  }

  let message = previous?.channelId === channel.id && previous.messageId
    ? await channel.messages.fetch(previous.messageId).catch(() => null)
    : null;
  if (message) {
    await message.edit({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });
  } else {
    message = await channel.send({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });
  }

  const id = previous?.id ?? randomUUID();
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualManagerPanel" ("id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId", "previousEveryoneView", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "updatedByDiscordId"=EXCLUDED."updatedByDiscordId", "previousEveryoneView"=EXCLUDED."previousEveryoneView", "updatedAt"=CURRENT_TIMESTAMP',
    id,
    String(args.guildId),
    String(args.nitradoConnId),
    channel.id,
    message.id,
    String(args.updatedByDiscordId),
    previousEveryoneView,
  );
  return (await readManagerPanel(args.guildId, args.nitradoConnId))!;
}

export async function disableVirtualManagerPanel(client: Client, guildId: GuildId, connId: NitradoConnId): Promise<void> {
  const panel = await readManagerPanel(guildId, connId);
  if (!panel) return;
  const tracked = await readManagerAccess(guildId, connId);
  await restorePanelChannel(client, panel, tracked);
  await prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
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

export async function refreshConfiguredVirtualManagerPanel(client: Client, guildId: GuildId, connId: NitradoConnId, updatedByDiscordId: UserDiscordId): Promise<void> {
  const panel = await readManagerPanel(guildId, connId);
  if (!panel) return;
  await configureVirtualManagerPanel(client, {
    guildId,
    nitradoConnId: connId,
    channelId: panel.channelId,
    updatedByDiscordId,
  });
}

export async function getVirtualManagerPanel(guildId: GuildId, connId: NitradoConnId): Promise<ManagerPanelRow | null> {
  return readManagerPanel(guildId, connId);
}
