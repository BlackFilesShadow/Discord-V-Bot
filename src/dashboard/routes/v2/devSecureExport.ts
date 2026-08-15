import { Router } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../../database/prisma';
import { logDevAction } from '../../middleware/devSecurity';

export const devSecureExportRouter = Router();

const SNOWFLAKE = /^\d{17,20}$/;
const ALLOWED_AUDIT_CATEGORIES = new Set(['ALL', 'SECURITY', 'MODERATION', 'GDPR']);
const MAX_ROWS = 50_000;

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80) || 'export';
}

function sendJsonAttachment(res: Parameters<typeof devSecureExportRouter.post>[1], filename: string, payload: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(filename)}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.send(JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
}

/** Sensibler Paketexport. Step-Up wird am Mount-Punkt vor dieser Route geprueft. */
devSecureExportRouter.post('/packages/:discordId', async (req, res) => {
  const discordId = String(req.params.discordId ?? '').trim();
  if (!SNOWFLAKE.test(discordId)) { res.status(400).json({ error: 'Ungültige Discord-ID.' }); return; }
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) { res.status(404).json({ error: 'User nicht in der Datenbank.' }); return; }
  const packages = await prisma.package.findMany({ where: { userId: user.id }, include: { files: true } });
  logDevAction('DATA_EXPORT', req, {
    type: 'packages', targetUserId: user.id, targetDiscordId: discordId,
    reason: String(req.body?.reason ?? ''), count: packages.length,
  });
  sendJsonAttachment(res, `pakete_${user.username}_${Date.now()}.json`, packages);
});

/** Sensibler GDPR-Userexport. */
devSecureExportRouter.post('/user/:discordId', async (req, res) => {
  const discordId = String(req.params.discordId ?? '').trim();
  if (!SNOWFLAKE.test(discordId)) { res.status(400).json({ error: 'Ungültige Discord-ID.' }); return; }
  const user = await prisma.user.findUnique({
    where: { discordId },
    include: {
      packages: true,
      uploads: true,
      downloads: true,
      moderationCases: true,
      appeals: true,
      levelData: true,
      xpRecords: true,
      giveawayEntries: true,
      pollVotes: true,
      gdprConsent: true,
    },
  });
  if (!user) { res.status(404).json({ error: 'User nicht in der Datenbank.' }); return; }
  logDevAction('GDPR_DATA_EXPORT', req, {
    targetUserId: user.id, targetDiscordId: discordId,
    reason: String(req.body?.reason ?? ''),
  });
  sendJsonAttachment(res, `nutzerdaten_${user.username}_${Date.now()}.json`, user);
});

/** Sensibler Audit-Logexport mit stabiler Cursor-Pagination und Hard-Cap. */
devSecureExportRouter.post('/logs', async (req, res) => {
  const category = String(req.body?.category ?? 'ALL').toUpperCase();
  if (!ALLOWED_AUDIT_CATEGORIES.has(category)) { res.status(400).json({ error: 'Ungültige Audit-Kategorie.' }); return; }
  const rawDays = Number(req.body?.days ?? 30);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 365) { res.status(400).json({ error: 'days muss 1..365 sein.' }); return; }
  const since = new Date(Date.now() - rawDays * 86_400_000);
  const where: Prisma.AuditLogWhereInput = { createdAt: { gte: since } };
  if (category !== 'ALL') where.category = category as Prisma.AuditLogWhereInput['category'];

  const rows: Awaited<ReturnType<typeof prisma.auditLog.findMany>> = [];
  let cursor: string | undefined;
  while (rows.length < MAX_ROWS) {
    const page = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(1000, MAX_ROWS - rows.length),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;
    rows.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 1000) break;
  }

  logDevAction('LOG_EXPORT', req, {
    category, days: rawDays, count: rows.length,
    reason: String(req.body?.reason ?? ''), capped: rows.length >= MAX_ROWS,
  });
  sendJsonAttachment(res, `audit_logs_${category}_${rawDays}d_${Date.now()}.json`, rows);
});
