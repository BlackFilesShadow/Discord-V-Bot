/**
 * Factions: pro Guild + Slot eigene Liste (composite-unique [guildId, nitradoConnId, name]).
 *
 * GET    /                Liste mit Member-Counts
 * POST   /                body: { name, flagUrl, joinPolicy?, leaderDiscordId?, embedChannelId? }
 * PATCH  /:id             body: gleiches Subset
 * DELETE /:id             cascadiert FactionMember
 * POST   /:id/members     body: { userDiscordId, role? }
 * DELETE /:id/members/:userDiscordId
 */
import { Router } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { asUserDiscordId } from '../../../types/scope';
import { logAuditDb } from '../../../utils/logger';
import { emitGuildEvent } from '../../socket/emitter';

export const factionsRouter = Router({ mergeParams: true });

const URL_RE = /^https?:\/\/[^\s<>"]{4,2000}$/i;
const VALID_POLICY = new Set(['OPEN', 'REQUEST', 'CLOSED']);
const VALID_ROLES = new Set(['LEADER', 'TREASURER', 'MEMBER', 'PENDING']);

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

function validateName(n: unknown): string | null {
  return (typeof n === 'string' && n.trim().length >= 2 && n.length <= 60) ? n.trim() : null;
}

factionsRouter.get('/', requireGuildPermission('factions.view'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const rows = await prisma.faction.findMany({
    where: { guildId: scope.guildId, nitradoConnId: connId },
    include: { _count: { select: { members: true } } },
    orderBy: { name: 'asc' },
  });
  res.json({
    factions: rows.map(f => ({
      id: f.id, name: f.name, flagUrl: f.flagUrl, bannerUrl: f.bannerUrl, mediaUrl: f.mediaUrl,
      leaderDiscordId: f.leaderDiscordId, treasurerDiscordId: f.treasurerDiscordId,
      embedChannelId: f.embedChannelId, joinPolicy: f.joinPolicy, isActive: f.isActive,
      memberCount: f._count.members,
    })),
  });
});

factionsRouter.post('/', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const connId = await activeSlotId(scope.guildId, req.query.slot);
  if (!connId) { res.status(404).json({ error: 'Kein Nitrado-Slot.' }); return; }
  const b = req.body ?? {};
  const name = validateName(b.name);
  if (!name) { res.status(400).json({ error: 'name 2..60 Zeichen.' }); return; }
  if (typeof b.flagUrl !== 'string' || !URL_RE.test(b.flagUrl)) { res.status(400).json({ error: 'flagUrl muss http(s) URL sein.' }); return; }
  const policy = typeof b.joinPolicy === 'string' && VALID_POLICY.has(b.joinPolicy) ? b.joinPolicy : 'REQUEST';

  try {
    const f = await prisma.faction.create({
      data: {
        guildId: scope.guildId, nitradoConnId: connId, name, flagUrl: b.flagUrl,
        bannerUrl: typeof b.bannerUrl === 'string' && URL_RE.test(b.bannerUrl) ? b.bannerUrl : null,
        mediaUrl: typeof b.mediaUrl === 'string' && URL_RE.test(b.mediaUrl) ? b.mediaUrl : null,
        leaderDiscordId: typeof b.leaderDiscordId === 'string' && /^\d{17,20}$/.test(b.leaderDiscordId) ? b.leaderDiscordId : null,
        embedChannelId: typeof b.embedChannelId === 'string' && /^\d{17,20}$/.test(b.embedChannelId) ? b.embedChannelId : null,
        joinPolicy: policy,
      },
    });
    logAuditDb('FACTION_CREATED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { slotId: connId, factionId: f.id, name } });
    emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
    res.status(201).json({ id: f.id, name: f.name });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'Fraktion mit diesem Namen existiert schon im Slot.' }); return;
    }
    throw e;
  }
});

factionsRouter.delete('/:id', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const out = await prisma.faction.deleteMany({
    where: { id: String(req.params.id), guildId: scope.guildId },
  });
  if (out.count === 0) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  logAuditDb('FACTION_DELETED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: String(req.params.id) } });
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: String(req.params.id) } });
  res.json({ ok: true });
});

factionsRouter.post('/:id/members', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  const { userDiscordId, role } = req.body ?? {};
  let target;
  try { target = asUserDiscordId(userDiscordId); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const r = typeof role === 'string' && VALID_ROLES.has(role) ? role : 'MEMBER';

  // Faction-Existenz + Scope-Check
  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }

  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  await prisma.factionMember.upsert({
    where: { factionId_userDiscordId: { factionId: f.id, userDiscordId: target } },
    create: { factionId: f.id, userDiscordId: target, role: r },
    update: { role: r },
  });
  logAuditDb('FACTION_MEMBER_ADDED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target, role: r } });
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.status(201).json({ ok: true });
});

factionsRouter.delete('/:id/members/:userDiscordId', requireGuildPermission('factions.manage'), async (req, res) => {
  const scope = req.guildScope!;
  let target;
  try { target = asUserDiscordId(String(req.params.userDiscordId)); } catch { res.status(400).json({ error: 'userDiscordId ungueltig.' }); return; }
  const f = await prisma.faction.findFirst({ where: { id: String(req.params.id), guildId: scope.guildId } });
  if (!f) { res.status(404).json({ error: 'Fraktion nicht gefunden.' }); return; }
  // eslint-disable-next-line local/no-unscoped-prisma-query -- f.id wurde oben mit guildId-Scope verifiziert; FactionMember erbt Scope via FK
  const out = await prisma.factionMember.deleteMany({
    where: { factionId: f.id, userDiscordId: target },
  });
  if (out.count === 0) { res.status(404).json({ error: 'Member nicht gefunden.' }); return; }
  logAuditDb('FACTION_MEMBER_REMOVED', 'FACTION', { actorUserId: req.auth!.userId, guildId: scope.guildId, details: { factionId: f.id, target } });
  emitGuildEvent(scope.guildId, { type: 'faction.changed', payload: { guildId: scope.guildId, factionId: f.id } });
  res.json({ ok: true });
});
