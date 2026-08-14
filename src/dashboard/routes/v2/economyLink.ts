/**
 * Spielidentitaets-Bindung (Discord <-> Spielidentitaet) pro Guild+Slot+User.
 * Vereinheitlicht auf GameIdentityLink (nur HMAC, kein Klartext-GUID).
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { forceLink, unlinkUser, type LinkClient } from '../../../modules/linking/linkService';
import { config } from '../../../config';
import { resolveDashboardGameServer, sendDashboardServerResolutionError } from './serverScope';

export const economyLinkRouter = Router({ mergeParams: true });

async function resolveForRequest(req: Parameters<typeof resolveDashboardGameServer>[0] extends never ? never : any) {
  const scope = req.guildScope!;
  return resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
}

economyLinkRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveDashboardGameServer(scope.guildId, scope.actorDiscordId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendDashboardServerResolutionError(res, resolution); return; }
  const connId = resolution.nitradoConnId;
  const links = await prisma.gameIdentityLink.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, status: 'VERIFIED' },
    orderBy: { verifiedAt: 'desc' },
    take: 500,
  });
  res.json({
    links: links.map(l => ({
      userDiscordId: l.userDiscordId,
      status: l.status,
      verifiedAt: l.verifiedAt,
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
  const { userDiscordId, gameId } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (typeof gameId !== 'string' || gameId.length < 3 || gameId.length > 64) { res.status(400).json({ error: 'gameId 3..64 Zeichen.' }); return; }

  const r = await forceLink(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target, gameId, config.security.encryptionKey);
  if (!r.ok) { res.status(409).json({ error: 'Spielidentitaet bereits mit anderem Account verknuepft.' }); return; }
  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.status(201).json({ userDiscordId: target, status: 'VERIFIED' });
});
