/**
 * Spielidentitaets-Bindung (Discord <-> DayZ) pro Guild+Slot+User.
 *
 * Die DayZ-GUID bleibt in GameIdentityLink gehasht. Fuer Anzeige und Force-Link
 * wird der exakte Spielername gegen die kanonischen PlayerSessions aufgeloest.
 */
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
import { config } from '../../../config';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';

export const economyLinkRouter = Router({ mergeParams: true });

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
  const removed = await unlinkUser(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target);
  logAuditDb('ECONOMY_LINK_REMOVED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.json({ ok: true, deleted: removed ? 1 : 0 });
});

economyLinkRouter.post('/grant', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const connId = resolution.nitradoConnId;
  const { userDiscordId } = req.body ?? {};
  // gameId bleibt als Rueckwaertskompatibilitaets-Alias fuer die bestehende
  // Dashboard-Oberflaeche erhalten, ist fachlich ab jetzt aber ein Spielername.
  const playerName = typeof req.body?.playerName === 'string'
    ? req.body.playerName.trim()
    : typeof req.body?.gameId === 'string'
      ? req.body.gameId.trim()
      : '';

  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (!isValidPlayerName(playerName)) { res.status(400).json({ error: 'Spielername 1..64 Zeichen, keine Zeilenumbrueche.' }); return; }

  const result = await forceLinkByPlayerName(
    prisma as unknown as SessionLinkClient,
    { guildId: scope.guildId, nitradoConnId: connId },
    target,
    playerName,
    config.security.encryptionKey,
  );
  if (!result.ok) {
    if (result.reason === 'PLAYER_NOT_SEEN') {
      res.status(404).json({ error: 'Spielername wurde auf diesem Gameserver noch nicht in den ADM-/Session-Daten erkannt.' });
      return;
    }
    if (result.reason === 'AMBIGUOUS_PLAYER_NAME') {
      res.status(409).json({ error: 'Spielername wurde mit mehreren DayZ-GUIDs beobachtet und ist nicht eindeutig.' });
      return;
    }
    if (result.reason === 'USER_ALREADY_LINKED') {
      res.status(409).json({ error: 'Discord-Account ist bereits mit einer anderen DayZ-Identitaet verknuepft.' });
      return;
    }
    res.status(409).json({ error: 'Spielername bzw. DayZ-GUID ist bereits mit einem anderen Discord-Account verknuepft.' });
    return;
  }

  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    details: { slotId: connId, target, playerName: result.playerName },
  });
  res.status(201).json({
    userDiscordId: target,
    playerName: result.playerName,
    gameId: result.gameId,
    status: 'VERIFIED',
    playedSeconds: result.playedSeconds,
  });
});
