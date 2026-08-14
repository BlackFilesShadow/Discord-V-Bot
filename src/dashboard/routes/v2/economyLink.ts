/**
 * Spielidentitaets-Bindung (Discord <-> Spielidentitaet) pro Guild+Slot+User.
 * Vereinheitlicht auf GameIdentityLink (nur HMAC, kein Klartext-GUID).
 *
 * GET    /                            (Owner / economy.view)  -> verifizierte Links im aktiven Slot
 * DELETE /:userDiscordId              (Owner / economy.manage) -> Soft-Unlink
 * POST   /grant                       (Owner / economy.manage) body: { userDiscordId, gameId } -> Force-Link
 *
 * Phase-4-Invariante: Bei mehreren aktiven Gameservern wird NIEMALS still der
 * kleinste Slot gewaehlt. Dann ist `?slot=1..4` zwingend erforderlich.
 */
import { Router } from 'express';
import type { Response } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asNitradoConnId, asUserDiscordId } from '../../../types/scope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../../modules/nitrado/gameServerScope';
import { logAuditDb } from '../../../utils/logger';
import { forceLink, unlinkUser, type LinkClient } from '../../../modules/linking/linkService';
import { config } from '../../../config';

export const economyLinkRouter = Router({ mergeParams: true });

type EconomyLinkServerResolution =
  | { kind: 'RESOLVED'; nitradoConnId: string }
  | { kind: 'NO_SERVER' }
  | { kind: 'SERVER_NOT_FOUND'; slot: number }
  | { kind: 'INVALID_SLOT' }
  | { kind: 'PROMPT_REQUIRED' };

export interface EconomyLinkServerCandidate {
  id: string;
  slot: number;
  status: string;
  nitradoServerId: string | null;
}

/** Pure Auswahlregel fuer Tests und REST-Wiring. */
export function selectEconomyLinkServer(
  candidates: EconomyLinkServerCandidate[],
  slotParam: unknown,
): EconomyLinkServerResolution {
  const usable = candidates.filter(c =>
    c.status === 'ACTIVE'
    && c.slot >= 1
    && c.slot <= MAX_GAME_SERVERS_PER_GUILD
    && typeof c.nitradoServerId === 'string'
    && c.nitradoServerId.length > 0,
  );

  if (slotParam !== undefined) {
    if (typeof slotParam !== 'string' || !/^\d+$/.test(slotParam)) return { kind: 'INVALID_SLOT' };
    const slot = Number(slotParam);
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_GAME_SERVERS_PER_GUILD) {
      return { kind: 'INVALID_SLOT' };
    }
    const selected = usable.find(c => c.slot === slot);
    return selected
      ? { kind: 'RESOLVED', nitradoConnId: selected.id }
      : { kind: 'SERVER_NOT_FOUND', slot };
  }

  if (usable.length === 0) return { kind: 'NO_SERVER' };
  if (usable.length === 1) return { kind: 'RESOLVED', nitradoConnId: usable[0].id };
  return { kind: 'PROMPT_REQUIRED' };
}

async function resolveServer(guildId: string, slotParam: unknown): Promise<EconomyLinkServerResolution> {
  const candidates = await prisma.nitradoConnection.findMany({
    where: { guildId },
    select: { id: true, slot: true, status: true, nitradoServerId: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });
  return selectEconomyLinkServer(candidates, slotParam);
}

function sendResolutionError(res: Response, resolution: Exclude<EconomyLinkServerResolution, { kind: 'RESOLVED' }>): void {
  switch (resolution.kind) {
    case 'INVALID_SLOT':
      res.status(400).json({ error: `slot muss eine Ganzzahl zwischen 1 und ${MAX_GAME_SERVERS_PER_GUILD} sein.` });
      return;
    case 'SERVER_NOT_FOUND':
      res.status(404).json({ error: `Slot ${resolution.slot} ist nicht als aktiver Gameserver nutzbar.` });
      return;
    case 'PROMPT_REQUIRED':
      res.status(409).json({ error: 'Mehrere aktive Gameserver gefunden. Bitte ?slot=1..4 explizit angeben.' });
      return;
    case 'NO_SERVER':
      res.status(404).json({ error: 'Kein aktiver Nitrado-Gameserver.' });
      return;
  }
}

economyLinkRouter.get('/', requireGuildPermission('economy.view'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveServer(scope.guildId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendResolutionError(res, resolution); return; }
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
  const resolution = await resolveServer(scope.guildId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendResolutionError(res, resolution); return; }
  const connId = asNitradoConnId(resolution.nitradoConnId);
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const removed = await unlinkUser(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target);
  logAuditDb('ECONOMY_LINK_REMOVED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.json({ ok: true, deleted: removed ? 1 : 0 });
});

economyLinkRouter.post('/grant', requireGuildPermission('economy.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const resolution = await resolveServer(scope.guildId, req.query.slot);
  if (resolution.kind !== 'RESOLVED') { sendResolutionError(res, resolution); return; }
  const connId = asNitradoConnId(resolution.nitradoConnId);
  const { userDiscordId, gameId } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  if (typeof gameId !== 'string' || gameId.length < 3 || gameId.length > 64) { res.status(400).json({ error: 'gameId 3..64 Zeichen.' }); return; }

  const r = await forceLink(prisma as unknown as LinkClient, { guildId: scope.guildId, nitradoConnId: connId }, target, gameId, config.security.encryptionKey);
  if (!r.ok) { res.status(409).json({ error: 'Spielidentitaet bereits mit anderem Account verknuepft.' }); return; }
  logAuditDb('ECONOMY_LINK_GRANTED', 'ECONOMY', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, target } });
  res.status(201).json({ userDiscordId: target, status: 'VERIFIED' });
});
