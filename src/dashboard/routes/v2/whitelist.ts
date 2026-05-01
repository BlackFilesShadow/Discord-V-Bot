/**
 * Whitelist: lokale DB als Source-of-Truth, Push zu Nitrado im Hintergrund
 * via NitradoJob (Outbox, Haertung A2). REST-Routen erstellen nur den Job
 * und den DB-Eintrag, kein synchroner API-Call.
 *
 * GET    /                           Liste lokaler Eintraege
 * POST   /                           body: { gameId, source? } -> WhitelistEntry + NitradoJob('WHITELIST_ADD')
 * DELETE /:gameId                    -> Loescht Entry + NitradoJob('WHITELIST_REMOVE')
 * GET    /requests                   PENDING-Requests
 * POST   /requests/:id/decision      body: { approve: boolean, reason? }
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAudit } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const whitelistRouter = Router({ mergeParams: true });

const STEAM64_RE = /^7656\d{13}$/;

async function activeSlotId(guildId: string, slotParam: unknown): Promise<string | null> {
  if (typeof slotParam === 'string' && /^[1-5]$/.test(slotParam)) {
    const c = await prisma.nitradoConnection.findUnique({
      where: { guildId_slot: { guildId, slot: Number(slotParam) } }, select: { id: true },
    });
    return c?.id ?? null;
  }
  const c = await prisma.nitradoConnection.findFirst({
    where: { guildId, status: 'ACTIVE' }, orderBy: { slot: 'asc' }, select: { id: true },
  });
  return c?.id ?? null;
}

whitelistRouter.get('/', requireGuildPermission('whitelist.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.whitelistEntry.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    orderBy: { approvedAt: 'desc' },
    take: 1000,
  });
  res.json({ entries: rows.map(r => ({ gameId: r.gameId, approvedBy: r.approvedByDiscordId, source: r.source, approvedAt: r.approvedAt })) });
});

whitelistRouter.post('/', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const { gameId, source } = req.body ?? {};
  if (typeof gameId !== 'string' || !STEAM64_RE.test(gameId)) { res.status(400).json({ error: 'gameId muss Steam64 sein.' }); return; }
  const src = (source === 'REQUEST' || source === 'IMPORT') ? source : 'DIRECT';

  try {
    await prisma.$transaction(async tx => {
      await tx.whitelistEntry.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId, gameId, source: src,
          approvedByDiscordId: scope.actorDiscordId,
        },
      });
      await tx.nitradoJob.create({
        data: {
          guildId: scope.guildId, nitradoConnId: connId,
          operation: 'WHITELIST_ADD', payload: { gameId },
        },
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'gameId bereits in Whitelist.' }); return;
    }
    throw e;
  }
  logAudit('WHITELIST_ADD', 'WHITELIST', { guildId: scope.guildId, slotId: connId, gameId, actor: scope.actorDiscordId });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'added' } });
  res.status(201).json({ ok: true });
});

whitelistRouter.delete('/:gameId', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const gameId = String(req.params.gameId);
  if (!STEAM64_RE.test(gameId)) { res.status(400).json({ error: 'gameId muss Steam64 sein.' }); return; }
  await prisma.$transaction(async tx => {
    await tx.whitelistEntry.deleteMany({
      where: { guildId: scope.guildId, nitradoConnId: connId, gameId },
    });
    await tx.nitradoJob.create({
      data: {
        guildId: scope.guildId, nitradoConnId: connId,
        operation: 'WHITELIST_REMOVE', payload: { gameId },
      },
    });
  });
  logAudit('WHITELIST_REMOVE', 'WHITELIST', { guildId: scope.guildId, slotId: connId, gameId, actor: scope.actorDiscordId });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, action: 'removed' } });
  res.json({ ok: true });
});

whitelistRouter.get('/requests', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.whitelistRequest.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ requests: rows });
});

whitelistRouter.post('/requests/:id/decision', requireGuildPermission('whitelist.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const { approve, reason } = req.body ?? {};
  if (typeof approve !== 'boolean') { res.status(400).json({ error: 'approve muss boolean sein.' }); return; }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) { res.status(400).json({ error: 'reason max 500.' }); return; }

  const reqRow = await prisma.whitelistRequest.findFirst({
    where: { id: String(req.params.id), guildId: scope.guildId },
  });
  if (!reqRow) { res.status(404).json({ error: 'Request nicht gefunden.' }); return; }
  if (reqRow.status !== 'PENDING') { res.status(409).json({ error: 'Request bereits entschieden.' }); return; }

  await prisma.$transaction(async tx => {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- reqRow.id wurde oben per findFirst({guildId}) verifiziert
    await tx.whitelistRequest.update({
      where: { id: reqRow.id },
      data: {
        status: approve ? 'APPROVED' : 'DENIED',
        decidedAt: new Date(),
        decidedByDiscordId: scope.actorDiscordId,
        reason: reason ?? null,
      },
    });
    if (approve) {
      await tx.whitelistEntry.upsert({
        where: { guildId_nitradoConnId_gameId: { guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId } },
        create: {
          guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId, gameId: reqRow.gameId,
          source: 'REQUEST', approvedByDiscordId: scope.actorDiscordId,
        },
        update: { approvedByDiscordId: scope.actorDiscordId, source: 'REQUEST', approvedAt: new Date() },
      });
      await tx.nitradoJob.create({
        data: {
          guildId: scope.guildId, nitradoConnId: reqRow.nitradoConnId,
          operation: 'WHITELIST_ADD', payload: { gameId: reqRow.gameId },
        },
      });
    }
  });
  logAudit('WHITELIST_REQUEST_DECISION', 'WHITELIST', {
    guildId: scope.guildId, requestId: reqRow.id, approve, actor: scope.actorDiscordId,
  });
  emitGuildEvent(scope.guildId, { type: 'whitelist.changed', payload: { guildId: scope.guildId, entryId: reqRow.id, action: 'decided' } });
  res.json({ ok: true });
});
