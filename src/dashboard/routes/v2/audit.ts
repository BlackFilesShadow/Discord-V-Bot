/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
/**
 * Audit-Log per Guild — Guild-Owner oder expliziter dashboard.access-Vollzugriff.
 *
 * GET /  ?category=&action=&limit=&cursor=  -> bis zu 100 Eintraege
 * GET /categories                           -> verfuegbare Kategorien (in DB vorhanden)
 */
import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { redactAuditDetails } from '../../../utils/auditRedaction';
import {
  AuditQueryValidationError,
  auditCursorFilter,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditAction,
  parseAuditCategory,
  parseAuditLimit,
} from './auditContract';

export const auditRouter = Router({ mergeParams: true });

function respondAuditValidationError(res: import('express').Response, error: unknown): boolean {
  if (!(error instanceof AuditQueryValidationError)) return false;
  res.status(400).json({ error: error.message });
  return true;
}

auditRouter.get('/', requireGuildPermission('dashboard.access'), async (req, res) => {
  const scope = req.guildScope!;

  try {
    // `before` war der alte, nur timestamp-basierte Cursor und ist bei identischen
    // Timestamps nicht verlustfrei. Fail-closed statt still auf unsichere Semantik
    // zurueckzufallen.
    if (req.query.before !== undefined) {
      res.status(400).json({ error: 'before wird nicht mehr unterstuetzt; bitte den kanonischen cursor verwenden.' });
      return;
    }

    const limit = parseAuditLimit(req.query.limit);
    const category = parseAuditCategory(req.query.category);
    const action = parseAuditAction(req.query.action);
    const cursor = decodeAuditCursor(req.query.cursor);

    const where: Prisma.AuditLogWhereInput = {
      guildId: scope.guildId,
      ...(category ? { category } : {}),
      ...(action ? { action: { contains: action, mode: 'insensitive' as const } } : {}),
      ...(cursor ? auditCursorFilter(cursor) : {}),
    };

    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        actor: { select: { discordId: true, username: true } },
        target: { select: { discordId: true, username: true } },
      },
    });

    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const lastVisible = visibleRows[visibleRows.length - 1];
    const nextCursor = hasMore && lastVisible
      ? encodeAuditCursor({ createdAt: lastVisible.createdAt, id: lastVisible.id })
      : null;

    res.json({
      entries: visibleRows.map(r => ({
        id: r.id,
        action: r.action,
        category: r.category,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor ? { discordId: r.actor.discordId, username: r.actor.username } : null,
        target: r.target ? { discordId: r.target.discordId, username: r.target.username } : null,
        channelId: r.channelId,
        // Zweite Sicherheitsbarriere fuer Legacy-Zeilen: auch top-level Arrays
        // und Strings werden rekursiv/inhaltlich redaktiert.
        details: redactAuditDetails(r.details),
      })),
      limit,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    if (respondAuditValidationError(res, error)) return;
    throw error;
  }
});

auditRouter.get('/categories', requireGuildPermission('dashboard.access'), async (req, res) => {
  const scope = req.guildScope!;
  const groups = await prisma.auditLog.groupBy({
    by: ['category'],
    where: { guildId: scope.guildId },
    _count: { _all: true },
  });
  res.json({
    categories: groups
      .map(g => ({ category: g.category, count: g._count._all }))
      .sort((a, b) => (b.count - a.count) || a.category.localeCompare(b.category)),
  });
});
