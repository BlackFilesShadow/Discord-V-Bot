/**
 * Spielidentitaets-Bindung (Discord <-> DayZ) pro Guild+Slot+User.
 *
 * Die DayZ-GUID bleibt in GameIdentityLink gehasht. Fuer Anzeige und Force-Link
 * wird der exakte Spielername gegen die kanonischen PlayerSessions aufgeloest.
 * Jede neue Verknuepfung startet zugleich die Reward-Epoche; Unlink beendet sie.
 */
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import {
  forceLinkByPlayerName,
  isValidPlayerName,
  listVerifiedLinkDetails,
  unlinkUser,
  type LinkClient,
  type SessionLinkClient,
} from '../../../modules/linking/linkService';
import {
  applySuccessfulLinkEconomyEffects,
  deactivateLinkRewardState,
} from '../../../modules/linking/linkRewards';
import {
  publishLinkingInfoEmbed,
  repostConfiguredLinkingInfoEmbed,
} from '../../../modules/linking/linkingChannel';
import { config } from '../../../config';
import { tryGetDashboardClient } from '../../clientRegistry';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';

export const economyLinkRouter = Router({ mergeParams: true });
const SNOWFLAKE_RE = /^\d{17,20}$/;

async function dashboardChannels(guildId: string) {
  const client = tryGetDashboardClient();
  if (!client) return [];
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return [];
  const channels = await guild.channels.fetch().catch(() => null);
  if (!channels) return [];
  return [...channels.values()]
    .filter(channel => channel
      && (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      && channel.permissionsFor(me)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
      ]))
    .map(channel => ({ id: channel!.id, name: channel!.name, type: channel!.type }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

economyLinkRouter.get('/channel', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const row = await prisma.linkingChannelConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId } },
  });
  res.json({ channelId: row?.channelId ?? null, infoMessageId: row?.infoMessageId ?? null, channels: await dashboardChannels(scope.guildId) });
});

economyLinkRouter.patch('/channel', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId.trim() : '';
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'channelId muss eine Discord-Snowflake sein.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Discord-Client ist derzeit nicht verfuegbar.' }); return; }

  const published = await publishLinkingInfoEmbed({ client, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId, channelId });
  if (!published.ok) { res.status(400).json({ error: published.reason }); return; }

  logAuditDb('LINK_CHANNEL_UPDATED', 'LINKING', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { slotId: resolution.nitradoConnId, channelId: published.channelId, messageId: published.messageId },
  });
  res.json(published);
});

economyLinkRouter.post('/channel/repost', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Discord-Client ist derzeit nicht verfuegbar.' }); return; }
  const published = await repostConfiguredLinkingInfoEmbed({ client, guildId: scope.guildId, nitradoConnId: resolution.nitradoConnId });
  if (!published.ok) { res.status(400).json({ error: published.reason }); return; }
  res.json(published);
});

economyLinkRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const connId = resolution.nitradoConnId;

  const links = await listVerifiedLinkDetails(
    prisma as unknown as SessionLinkClient,
    { guildId: scope.guildId, nitradoConnId: connId },
    config.security.encryptionKey,
    500,
  );
  res.json({
    links: links.map(link => ({
      userDiscordId: link.userDiscordId,
      playerName: link.playerName,
      gameId: link.gameId,
      status: 'VERIFIED',
      verifiedAt: link.verifiedAt,
    })),
  });
});

economyLinkRouter.delete('/:userDiscordId', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const connId = resolution.nitradoConnId;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const linkScope = { guildId: scope.guildId, nitradoConnId: connId };
  const removed = await unlinkUser(prisma as unknown as LinkClient, linkScope, target);
  if (removed) await deactivateLinkRewardState(linkScope, target);
  logAuditDb('ECONOMY_LINK_REMOVED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.json({ ok: true, deleted: removed ? 1 : 0 });
});

economyLinkRouter.post('/grant', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const connId = resolution.nitradoConnId;
  const { userDiscordId } = req.body ?? {};
  const playerName = typeof req.body?.playerName === 'string'
    ? req.body.playerName.trim()
    : typeof req.body?.gameId === 'string'
      ? req.body.gameId.trim()
      : '';

  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (!isValidPlayerName(playerName)) { res.status(400).json({ error: 'Spielername 1..64 Zeichen, keine Zeilenumbrueche.' }); return; }

  const linkScope = { guildId: scope.guildId, nitradoConnId: connId };
  const result = await forceLinkByPlayerName(
    prisma as unknown as SessionLinkClient,
    linkScope,
    target,
    playerName,
    config.security.encryptionKey,
  );
  if (!result.ok) {
    if (result.reason === 'PLAYER_NOT_SEEN') { res.status(404).json({ error: 'Spielername wurde auf diesem Gameserver noch nicht in den ADM-/Session-Daten erkannt.' }); return; }
    if (result.reason === 'AMBIGUOUS_PLAYER_NAME') { res.status(409).json({ error: 'Spielername wurde mit mehreren DayZ-GUIDs beobachtet und ist nicht eindeutig.' }); return; }
    if (result.reason === 'USER_ALREADY_LINKED') { res.status(409).json({ error: 'Discord-Account ist bereits mit einer anderen DayZ-Identitaet verknuepft.' }); return; }
    res.status(409).json({ error: 'Spielername bzw. DayZ-GUID ist bereits mit einem anderen Discord-Account verknuepft.' });
    return;
  }

  const startBalance = await applySuccessfulLinkEconomyEffects({
    scope: linkScope,
    userDiscordId: target,
    gameId: result.gameId,
    secret: config.security.encryptionKey,
    newLink: !result.alreadyLinked,
  });

  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: {
      slotId: connId,
      target,
      playerName: result.playerName,
      startBalanceGranted: startBalance.granted,
      startBalanceAmount: startBalance.amount.toString(),
    },
  });
  res.status(201).json({
    userDiscordId: target,
    playerName: result.playerName,
    gameId: result.gameId,
    status: 'VERIFIED',
    playedSeconds: result.playedSeconds,
    rewardEligibleFrom: new Date().toISOString(),
    startBalance: { granted: startBalance.granted, amount: startBalance.amount.toString() },
  });
});
