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
}

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
  guildId: GuildId; connId: NitradoConnId; accountId: string; channelId: string | null;
  messageId: string | null; archiveThreadId: string | null; error?: string | null;
}) {
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountProjection" ("accountId", "guildId", "nitradoConnId", "channelId", "messageId", "archiveThreadId", "lastSyncedAt", "lastSyncError", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "archiveThreadId"=EXCLUDED."archiveThreadId", "lastSyncedAt"=EXCLUDED."lastSyncedAt", "lastSyncError"=EXCLUDED."lastSyncError", "updatedAt"=CURRENT_TIMESTAMP',
    args.accountId, String(args.guildId), String(args.connId), args.channelId, args.messageId, args.archiveThreadId,
    args.error ? null : new Date(), args.error ? args.error.slice(0, 500) : null,
  );
}

function threadName(name: string): string {
  const clean = name.normalize('NFKC').replace(/[\r\n\t]/g, ' ').trim().replace(/\s+/g, ' ');
  return `Archiv · ${clean}`.slice(0, 100) || 'Archiv · Virtuelles Konto';
}

/**
 * Discord is a projection only. Money has already committed before this runs.
 * A Discord failure is recorded and may be retried without changing balances.
 */
export async function syncVirtualAccountProjection(client: Client, guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<ProjectionRow | null> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const metadata = await getVirtualAccountMetadata(guildId, connId, accountId);
  if (!metadata?.channelId) {
    await writeProjection({ guildId, connId, accountId, channelId: null, messageId: null, archiveThreadId: null });
    return null;
  }
  const guild = client.guilds.cache.get(String(guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const channel = await guild.channels.fetch(metadata.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Konto-Integration benoetigt einen normalen Discord-Textkanal.');

  const previous = await readProjection(guildId, connId, accountId);
  let message = previous?.channelId === channel.id && previous.messageId
    ? await channel.messages.fetch(previous.messageId).catch(() => null)
    : null;

  try {
    if (previous?.channelId && previous.channelId !== channel.id && previous.messageId) {
      const oldChannel = await guild.channels.fetch(previous.channelId).catch(() => null);
      if (oldChannel?.isTextBased() && 'messages' in oldChannel) {
        const oldMessage = await (oldChannel as TextChannel).messages.fetch(previous.messageId).catch(() => null);
        await oldMessage?.delete().catch(() => undefined);
      }
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
    let archiveThread = archiveThreadId ? await guild.channels.fetch(archiveThreadId).catch(() => null) : null;
    if (!archiveThread || !archiveThread.isThread()) {
      const thread = await message.startThread({
        name: threadName(account.name),
        autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
        reason: 'V-Bot Transaktionsarchiv fuer virtuelles Konto',
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
    }

    await writeProjection({ guildId, connId, accountId, channelId: channel.id, messageId: message.id, archiveThreadId });
    return await readProjection(guildId, connId, accountId);
  } catch (error) {
    await writeProjection({
      guildId, connId, accountId, channelId: channel.id, messageId: message?.id ?? previous?.messageId ?? null,
      archiveThreadId: previous?.archiveThreadId ?? null, error: (error as Error).message,
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
  if (!projection?.archiveThreadId) projection = await syncVirtualAccountProjection(client, args.guildId, args.nitradoConnId, args.accountId);
  if (!projection?.archiveThreadId) throw new Error('Transaktionsarchiv ist nicht konfiguriert.');
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const thread = await client.channels.fetch(projection.archiveThreadId).catch(() => null);
  if (!thread || !thread.isThread()) throw new Error('Transaktionsarchiv-Thread ist nicht erreichbar.');
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
  const rows = await rawDb().$queryRawUnsafe<ManagerPanelRow[]>('SELECT "id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId" FROM "EconomyVirtualManagerPanel" WHERE "guildId"=$1 AND "nitradoConnId"=$2 LIMIT 1', String(guildId), String(connId));
  return rows[0] ?? null;
}

/**
 * Applies only overwrites tracked by V-Bot. Manual user overwrites are never
 * mass-deleted. @everyone is denied ViewChannel because this channel is the
 * manager surface; guild owner/Administrator still retain Discord-level access.
 */
export async function configureVirtualManagerPanel(client: Client, args: {
  guildId: GuildId; nitradoConnId: NitradoConnId; channelId: string; updatedByDiscordId: UserDiscordId;
}): Promise<ManagerPanelRow> {
  const guild = client.guilds.cache.get(String(args.guildId));
  if (!guild) throw new Error('Bot ist nicht in der Discord-Guild.');
  const channel = await guild.channels.fetch(args.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) throw new Error('Kontoverwaltung benoetigt einen normalen Discord-Textkanal.');
  if (!channel.permissionsFor(guild.members.me!).has(PermissionFlagsBits.ManageChannels)) throw new Error('V-Bot benoetigt „Kanäle verwalten“ fuer die managerbasierte Kanal-Integration.');

  const previous = await readManagerPanel(args.guildId, args.nitradoConnId);
  const tracked = await rawDb().$queryRawUnsafe<Array<{ channelId: string; userDiscordId: string }>>(
    'SELECT "channelId", "userDiscordId" FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2', String(args.guildId), String(args.nitradoConnId),
  );
  if (previous?.channelId && previous.channelId !== channel.id) {
    const oldChannel = await guild.channels.fetch(previous.channelId).catch(() => null);
    if (oldChannel?.type === ChannelType.GuildText) {
      for (const row of tracked.filter(item => item.channelId === oldChannel.id)) {
        await oldChannel.permissionOverwrites.delete(row.userDiscordId, 'V-Bot Kontoverwalter-Zugriff entfernt').catch(() => undefined);
      }
    }
    await rawDb().$executeRawUnsafe('DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2', String(args.guildId), String(args.nitradoConnId));
  }

  await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }, { reason: 'V-Bot Kontoverwalter-Kanal' });
  const managers = await rawDb().$queryRawUnsafe<Array<{ userDiscordId: string }>>(
    'SELECT DISTINCT "userDiscordId" FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2', String(args.guildId), String(args.nitradoConnId),
  );
  const desired = new Set(managers.map(row => row.userDiscordId));
  const currentTracked = previous?.channelId === channel.id ? tracked : [];
  for (const row of currentTracked) {
    if (!desired.has(row.userDiscordId)) {
      await channel.permissionOverwrites.delete(row.userDiscordId, 'V-Bot Kontoverwalter entfernt').catch(() => undefined);
      await rawDb().$executeRawUnsafe('DELETE FROM "EconomyVirtualManagerPanelAccess" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3', String(args.guildId), String(args.nitradoConnId), row.userDiscordId);
    }
  }
  for (const user of desired) {
    const member = await guild.members.fetch(user).catch(() => null);
    if (!member || member.user.bot) continue;
    await channel.permissionOverwrites.edit(user, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }, { reason: 'V-Bot Kontoverwalter' });
    await rawDb().$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualManagerPanelAccess" ("guildId", "nitradoConnId", "channelId", "userDiscordId", "createdAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO UPDATE SET "channelId"=EXCLUDED."channelId"',
      String(args.guildId), String(args.nitradoConnId), channel.id, user,
    );
  }

  let message = previous?.channelId === channel.id && previous.messageId ? await channel.messages.fetch(previous.messageId).catch(() => null) : null;
  if (message) await message.edit({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });
  else message = await channel.send({ embeds: [managerPanelEmbed()], components: managerPanelButtons(args.nitradoConnId), allowedMentions: { parse: [] } });

  const id = previous?.id ?? randomUUID();
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualManagerPanel" ("id", "guildId", "nitradoConnId", "channelId", "messageId", "updatedByDiscordId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId") DO UPDATE SET "channelId"=EXCLUDED."channelId", "messageId"=EXCLUDED."messageId", "updatedByDiscordId"=EXCLUDED."updatedByDiscordId", "updatedAt"=CURRENT_TIMESTAMP',
    id, String(args.guildId), String(args.nitradoConnId), channel.id, message.id, String(args.updatedByDiscordId),
  );
  return (await readManagerPanel(args.guildId, args.nitradoConnId))!;
}

export async function refreshConfiguredVirtualManagerPanel(client: Client, guildId: GuildId, connId: NitradoConnId, updatedByDiscordId: UserDiscordId): Promise<void> {
  const panel = await readManagerPanel(guildId, connId);
  if (!panel) return;
  await configureVirtualManagerPanel(client, { guildId, nitradoConnId: connId, channelId: panel.channelId, updatedByDiscordId });
}

export async function getVirtualManagerPanel(guildId: GuildId, connId: NitradoConnId): Promise<ManagerPanelRow | null> {
  return readManagerPanel(guildId, connId);
}
