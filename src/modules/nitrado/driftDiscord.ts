import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';
import { resolveDelegatedPermissionContext } from '../permissions/access';
import { NitradoClient } from './nitradoClient';
import { enqueueWhitelistAdd, type WhitelistOutboxClient } from '../whitelist/whitelistOutbox';
import { enqueueServerBanAdd, type BanOutboxClient } from '../bans/banOutbox';
import { matchesBanIdentifier } from '../bans/banTarget';
import { vEmbed } from '../../utils/embedDesign';

type DriftKind = 'WHITELIST' | 'BAN';

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function components(kind: DriftKind, noticeId: string) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ndrift:accept:${kind}:${noticeId}`).setLabel('Nitrado-Zustand übernehmen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`ndrift:restore:${kind}:${noticeId}`).setLabel('V-Bot-Zustand wiederherstellen').setStyle(ButtonStyle.Primary),
  )];
}

async function sendNotice(client: Client, args: { guildId: string; nitradoConnId: string; kind: DriftKind; subjectKey: string }): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: args.guildId, nitradoConnId: args.nitradoConnId } },
    select: { whitelistCatalogChannelId: true, banCatalogChannelId: true },
  });
  const channelId = args.kind === 'WHITELIST' ? settings?.whitelistCatalogChannelId : settings?.banCatalogChannelId;
  if (!channelId) return;

  let notice: { id: string };
  try {
    notice = await prisma.nitradoDriftNotice.create({
      data: { ...args, channelId },
      select: { id: true },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') return;
    throw error;
  }

  const guild = client.guilds.cache.get(args.guildId);
  const channel = guild ? await guild.channels.fetch(channelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await prisma.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: args.guildId } });
    logger.warn(`Nitrado-Driftmeldung nicht gesendet: Katalogkanal ${channelId} ist nicht erreichbar.`);
    return;
  }

  const label = args.kind === 'WHITELIST' ? `Whitelist-Eintrag \`${args.subjectKey.replace(/`/g, "'")}\`` : 'Ban-Eintrag';
  try {
    const message = await (channel as TextChannel).send({
      embeds: [vEmbed(0xfaa61a)
        .setTitle('Manuelle Nitrado-Abweichung erkannt')
        .setDescription(`${label} wurde direkt bei Nitrado entfernt. Entscheide bewusst, welcher Zustand gelten soll.`)
        .setTimestamp()],
      components: components(args.kind, notice.id),
      allowedMentions: { parse: [] },
    });
    await prisma.nitradoDriftNotice.updateMany({ where: { id: notice.id, guildId: args.guildId, messageId: null }, data: { messageId: message.id } });
  } catch (error) {
    await prisma.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: args.guildId, messageId: null } });
    throw error;
  }
}

export async function notifyNitradoWhitelistDrift(client: Client, args: { guildId: string; nitradoConnId: string; gameId: string }): Promise<void> {
  await sendNotice(client, { ...args, kind: 'WHITELIST', subjectKey: args.gameId });
}

export async function notifyNitradoBanDrift(client: Client, args: { guildId: string; nitradoConnId: string; banId: string }): Promise<void> {
  await sendNotice(client, { ...args, kind: 'BAN', subjectKey: args.banId });
}

export async function clearNitradoDriftNotice(client: Client | undefined, guildId: string, nitradoConnId: string, kind: DriftKind, subjectKey: string): Promise<void> {
  const notice = await prisma.nitradoDriftNotice.findFirst({ where: { guildId, nitradoConnId, kind, subjectKey } });
  await prisma.nitradoDriftNotice.deleteMany({ where: { guildId, nitradoConnId, kind, subjectKey } });
  if (!client || !notice?.messageId) return;
  const guild = client.guilds.cache.get(guildId);
  const channel = guild ? await guild.channels.fetch(notice.channelId).catch(() => null) : null;
  if (!channel || channel.type !== ChannelType.GuildText) return;
  const message = await (channel as TextChannel).messages.fetch(notice.messageId).catch(() => null);
  await message?.edit({ components: [] }).catch(() => undefined);
}

async function hasPermission(interaction: ButtonInteraction, kind: DriftKind): Promise<boolean> {
  if (!interaction.guild || !interaction.guildId) return false;
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const delegated = await resolveDelegatedPermissionContext(interaction.guild, interaction.user.id);
  return Boolean(delegated.member && delegated.permissions.has(kind === 'WHITELIST' ? 'whitelist.manage' : 'bans.manage'));
}

async function remoteNames(guildId: string, connId: string, kind: DriftKind): Promise<string[] | null> {
  const connection = await prisma.nitradoConnection.findFirst({
    where: { id: connId, guildId, status: 'ACTIVE', nitradoServerId: { not: null } },
    select: { encryptedToken: true, nitradoServerId: true },
  });
  if (!connection?.nitradoServerId) return null;
  const api = new NitradoClient(decrypt(connection.encryptedToken, config.security.encryptionKey));
  const rows = kind === 'WHITELIST'
    ? await api.getWhitelist(connection.nitradoServerId)
    : await api.getBanlist(connection.nitradoServerId);
  return rows.map(row => row.identifier);
}

async function finish(interaction: ButtonInteraction, content: string): Promise<void> {
  await interaction.message.edit({ components: [] }).catch(() => undefined);
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

export async function handleNitradoDriftButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, kindRaw, noticeId] = interaction.customId.split(':');
  const kind = kindRaw === 'WHITELIST' || kindRaw === 'BAN' ? kindRaw : null;
  if (!kind || (action !== 'accept' && action !== 'restore') || !noticeId || !interaction.guildId) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let permitted = false;
  try {
    permitted = await hasPermission(interaction, kind);
  } catch (error) {
    logger.warn(`Nitrado-Driftberechtigung fehlgeschlagen: ${(error as Error).message}`);
  }
  if (!permitted) {
    await interaction.editReply('Dir fehlt die passende V-Bot-Berechtigung für diese Entscheidung.');
    return;
  }

  const notice = await prisma.nitradoDriftNotice.findFirst({
    where: { id: noticeId, guildId: interaction.guildId, kind, channelId: interaction.channelId, messageId: interaction.message.id },
  });
  if (!notice) {
    await interaction.editReply('Diese Drift-Meldung ist nicht mehr aktuell.');
    return;
  }

  let names: string[] | null;
  try {
    names = await remoteNames(notice.guildId, notice.nitradoConnId, kind);
  } catch (error) {
    logger.warn(`Nitrado-Driftaktion Remote-Read fehlgeschlagen: ${(error as Error).message}`);
    await interaction.editReply('Nitrado konnte nicht frisch gelesen werden. Es wurde nichts geändert.');
    return;
  }
  if (!names) {
    await interaction.editReply('Die Nitrado-Verbindung ist nicht aktiv. Es wurde nichts geändert.');
    return;
  }

  if (kind === 'WHITELIST') {
    if (names.some(name => normalize(name) === normalize(notice.subjectKey))) {
      await clearNitradoDriftNotice(interaction.client, notice.guildId, notice.nitradoConnId, kind, notice.subjectKey);
      await finish(interaction, 'Der Whitelist-Eintrag ist bei Nitrado wieder vorhanden. Die Meldung wurde geschlossen.');
      return;
    }
    if (action === 'accept') {
      const result = await prisma.$transaction(async tx => {
        const deleted = await tx.whitelistEntry.deleteMany({ where: { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, gameId: notice.subjectKey, syncState: 'SYNCED' } });
        if (!deleted.count) return false;
        await tx.whitelistRequest.updateMany({ where: { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, gameId: notice.subjectKey, status: { in: ['PENDING', 'APPROVED'] } }, data: { status: 'CANCELLED' } });
        await tx.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: notice.guildId } });
        return true;
      });
      if (!result) { await interaction.editReply('Der lokale Whitelist-Eintrag wurde bereits geändert.'); return; }
      logAudit('NITRADO_WHITELIST_DRIFT_RESOLVED', 'WHITELIST', { guildId: notice.guildId, actorUserId: interaction.user.id, details: { nitradoConnId: notice.nitradoConnId, gameId: notice.subjectKey, decision: 'ACCEPT_NITRADO' } });
      await finish(interaction, 'Nitrado-Zustand übernommen: Die lokale Whitelist-Freigabe wurde entfernt.');
      return;
    }
    const result = await prisma.$transaction(async tx => {
      const updated = await tx.whitelistEntry.updateMany({ where: { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, gameId: notice.subjectKey, syncState: 'SYNCED' }, data: { syncState: 'LOCAL_ONLY', lastSyncedAt: null } });
      if (!updated.count) return false;
      await enqueueWhitelistAdd(tx as unknown as WhitelistOutboxClient, { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId }, notice.subjectKey);
      await tx.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: notice.guildId } });
      return true;
    });
    if (!result) { await interaction.editReply('Der lokale Whitelist-Eintrag wurde bereits geändert.'); return; }
    logAudit('NITRADO_WHITELIST_DRIFT_RESOLVED', 'WHITELIST', { guildId: notice.guildId, actorUserId: interaction.user.id, details: { nitradoConnId: notice.nitradoConnId, gameId: notice.subjectKey, decision: 'RESTORE_VBOT' } });
    await finish(interaction, 'V-Bot-Zustand wird wiederhergestellt: Der Whitelist-Add wurde eingereiht.');
    return;
  }

  const ban = await prisma.serverBanEntry.findFirst({ where: { id: notice.subjectKey, guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, active: true, appliedRemotely: true }, select: { id: true, identityHash: true } });
  if (!ban) { await interaction.editReply('Der lokale Ban wurde bereits geändert.'); return; }
  if (names.some(name => matchesBanIdentifier(name, ban.identityHash, config.security.encryptionKey))) {
    await clearNitradoDriftNotice(interaction.client, notice.guildId, notice.nitradoConnId, kind, notice.subjectKey);
    await finish(interaction, 'Der Ban ist bei Nitrado wieder vorhanden. Die Meldung wurde geschlossen.');
    return;
  }
  if (action === 'accept') {
    await prisma.$transaction(async tx => {
      await tx.serverBanEntry.updateMany({ where: { id: ban.id, guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, active: true, appliedRemotely: true }, data: { active: false, appliedRemotely: false, liftedAt: new Date() } });
      await tx.serverBanExpiryNotice.updateMany({ where: { banId: ban.id, guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, status: { in: ['PENDING', 'READY', 'SENDING', 'FAILED'] } }, data: { status: 'CANCELLED', identifierEnc: null, leaseUntil: null, lastError: null } });
      await tx.serverBanRemoteIdentity.deleteMany({ where: { banId: ban.id } });
      await tx.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: notice.guildId } });
    });
    logAudit('NITRADO_BAN_DRIFT_RESOLVED', 'MODERATION', { guildId: notice.guildId, actorUserId: interaction.user.id, details: { nitradoConnId: notice.nitradoConnId, banId: ban.id, decision: 'ACCEPT_NITRADO' } });
    await finish(interaction, 'Nitrado-Zustand übernommen: Der lokale Ban wurde aufgehoben.');
    return;
  }
  const identity = await prisma.serverBanRemoteIdentity.findUnique({ where: { banId: ban.id }, select: { identifierEnc: true } });
  if (!identity) { await interaction.editReply('Der verschlüsselte Gameserver-Identifier fehlt. Eine Wiederherstellung ist nicht sicher möglich.'); return; }
  let identifier: string;
  try { identifier = decrypt(identity.identifierEnc, config.security.encryptionKey).trim(); } catch { await interaction.editReply('Der gespeicherte Gameserver-Identifier ist nicht lesbar.'); return; }
  if (!matchesBanIdentifier(identifier, ban.identityHash, config.security.encryptionKey)) { await interaction.editReply('Der gespeicherte Gameserver-Identifier ist ungültig.'); return; }
  await prisma.$transaction(async tx => {
    await tx.serverBanEntry.updateMany({ where: { id: ban.id, guildId: notice.guildId, nitradoConnId: notice.nitradoConnId, active: true, appliedRemotely: true }, data: { appliedRemotely: false } });
    await enqueueServerBanAdd(tx as unknown as BanOutboxClient, { guildId: notice.guildId, nitradoConnId: notice.nitradoConnId }, ban.id, identifier, config.security.encryptionKey);
    await tx.nitradoDriftNotice.deleteMany({ where: { id: notice.id, guildId: notice.guildId } });
  });
  logAudit('NITRADO_BAN_DRIFT_RESOLVED', 'MODERATION', { guildId: notice.guildId, actorUserId: interaction.user.id, details: { nitradoConnId: notice.nitradoConnId, banId: ban.id, decision: 'RESTORE_VBOT' } });
  await finish(interaction, 'V-Bot-Zustand wird wiederhergestellt: Der Ban-Add wurde eingereiht.');
}