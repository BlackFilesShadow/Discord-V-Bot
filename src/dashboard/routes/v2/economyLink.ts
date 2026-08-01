/**
 * Spielidentitaets-Bindung (Discord <-> Spielidentitaet) pro Guild+Slot+User.
 * Vereinheitlicht auf GameIdentityLink (nur HMAC, kein Klartext-GUID).
 *
 * GET    /                            (Owner / economy.view)  -> verifizierte Links im aktiven Slot
 * DELETE /:userDiscordId              (Owner / economy.manage) -> Soft-Unlink
 * POST   /grant                       (Owner / economy.manage) body: { userDiscordId, gameId } -> Force-Link
 *
 * Slot wird via Query-Param `?slot=N` ausgewaehlt; default = kleinster aktiver.
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { getSlot } from '../../../modules/nitrado/repository';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { forceLink, unlinkUser, type LinkClient } from '../../../modules/linking/linkService';
import { config } from '../../../config';

export const economyLinkRouter = Router({ mergeParams: true });

async function resolveSlotId(guildId: string, slotParam: unknown): Promise<string | null> {
  if (typeof slotParam === 'string' && /^[1-5]$/.test(slotParam)) {
    const conn = await getSlot(guildId as never, Number(slotParam));
    return conn?.id ?? null;
  }
  const conn = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  return conn?.id ?? null;
}

economyLinkRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await resolveSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
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
  const connId = await resolveSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const removed = await unlinkUser(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target);
  logAuditDb('ECONOMY_LINK_REMOVED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.json({ ok: true, deleted: removed ? 1 : 0 });
});

economyLinkRouter.post('/grant', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await resolveSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const { userDiscordId, gameId } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (typeof gameId !== 'string' || gameId.length < 3 || gameId.length > 64) { res.status(400).json({ error: 'gameId 3..64 Zeichen.' }); return; }

  const r = await forceLink(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target, gameId, config.security.encryptionKey);
  if (!r.ok) { res.status(409).json({ error: 'Spielidentitaet bereits mit anderem Account verknuepft.' }); return; }
  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.status(201).json({ userDiscordId: target, status: 'VERIFIED' });
});
