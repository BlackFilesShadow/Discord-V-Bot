/**
 * Audit-Log per Guild — nur Owner.
 *
 * GET /  ?category=&action=&limit=&before=  -> bis zu 100 Eintraege
 * GET /categories                            -> verfuegbare Kategorien (in DB vorhanden)
 */
import { Router } from 'express';
import { requireGuildOwner } from '../../middleware/auth';
import prisma from '../../../database/prisma';

export const auditRouter = Router({ mergeParams: true });

const MAX_LIMIT = 100;

auditRouter.get('/', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || 50));
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const action = typeof req.query.action === 'string' ? req.query.action : undefined;
  const beforeRaw = typeof req.query.before === 'string' ? req.query.before : undefined;
  // Strikte ISO-8601-Validierung (vermeidet, dass Garbage-Input still ignoriert wird und falsche Pagination liefert).
  let before: Date | undefined;
  if (beforeRaw) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(beforeRaw)) {
      res.status(400).json({ error: 'before muss ISO-8601 UTC sein (YYYY-MM-DDTHH:mm:ss.sssZ).' }); return;
    }
    const d = new Date(beforeRaw);
    if (isNaN(d.getTime())) { res.status(400).json({ error: 'before ungueltig.' }); return; }
    before = d;
  }

  const where: Record<string, unknown> = { guildId: scope.guildId };
  if (category) where.category = category;
  if (action) where.action = { contains: action, mode: 'insensitive' };
  if (before) where.createdAt = { lt: before };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { discordId: true, username: true } },
      target: { select: { discordId: true, username: true } },
    },
  });

  res.json({
    entries: rows.map(r => ({
      id: r.id,
      action: r.action,
      category: r.category,
      createdAt: r.createdAt.toISOString(),
      actor: r.actor ? { discordId: r.actor.discordId, username: r.actor.username } : null,
      target: r.target ? { discordId: r.target.discordId, username: r.target.username } : null,
      channelId: r.channelId,
      details: r.details,
    })),
    limit,
    hasMore: rows.length === limit,
  });
});

auditRouter.get('/categories', requireGuildOwner, async (req, res) => {
  const scope = req.guildScope!;
  const groups = await prisma.auditLog.groupBy({
    by: ['category'],
    where: { guildId: scope.guildId },
    _count: { _all: true },
  });
  res.json({
    categories: groups
      .map(g => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => b.count - a.count),
  });
});
