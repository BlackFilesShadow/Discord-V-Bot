/**
 * EconomyLink — Discord <-> Nitrado-Spielername-Bindung pro Guild+Slot+User.
 *
 * GET    /                            (Owner / economy.view)  -> alle Links der Guild im aktiven Slot
 * DELETE /:userDiscordId              (Owner / economy.manage) -> force-unlink
 * POST   /grant                       (Owner / economy.manage) body: { userDiscordId, gameId } -> Force-Link Override
 *
 * Slot wird via Query-Param `?slot=N` ausgewaehlt; default = kleinster aktiver.
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { getSlot } from '../../../modules/nitrado/repository';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';

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
  const links = await prisma.economyLink.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    orderBy: { linkedAt: 'desc' },
    take: 500,
  });
  res.json({
    links: links.map(l => ({
      userDiscordId: l.userDiscordId,
      gameId: l.gameId,
      linkedAt: l.linkedAt,
    })),
  });
});

economyLinkRouter.delete('/:userDiscordId', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await resolveSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const out = await prisma.economyLink.deleteMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, userDiscordId: target },
  });
  logAuditDb('ECONOMY_LINK_REMOVED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.json({ ok: true, deleted: out.count });
});

economyLinkRouter.post('/grant', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await resolveSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const { userDiscordId, gameId } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (typeof gameId !== 'string' || gameId.length < 3 || gameId.length > 64) { res.status(400).json({ error: 'gameId 3..64 Zeichen.' }); return; }

  // Force-Override: vorher ggf. existierende Link fuer diesen User loeschen
  await prisma.economyLink.deleteMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, userDiscordId: target },
  });
  // Auch ggf. Link, der diese gameId schon hat (an anderen User), loeschen
  await prisma.economyLink.deleteMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, gameId },
  });
  const link = await prisma.economyLink.create({
    data: { guildId: scope.guildId, nitradoConnId: connId, userDiscordId: target, gameId },
  });
  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target, gameId } });
  res.status(201).json({ userDiscordId: link.userDiscordId, gameId: link.gameId, linkedAt: link.linkedAt });
});
