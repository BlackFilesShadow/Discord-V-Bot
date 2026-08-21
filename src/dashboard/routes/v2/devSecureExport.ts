/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: intentional cross-tenant system/admin surface (authZ outside Prisma where). */
import { Router, type Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../../../database/prisma';
import { logDevAction } from '../../middleware/devSecurity';

export const devSecureExportRouter = Router();

const SNOWFLAKE = /^\d{17,20}$/;
const ALLOWED_AUDIT_CATEGORIES = new Set(['ALL', 'SECURITY', 'MODERATION', 'GDPR']);
const MAX_ROWS = 50_000;
const AUDIT_PAGE_SIZE = 1000;

function safeFilenamePart(value: string): string {
  return value.replace(/[^a-z0-9_.-]/gi, '_').slice(0, 80) || 'export';
}

function jsonStringify(payload: unknown, space?: number): string {
  return JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? value.toString() : value, space);
}

function setJsonAttachmentHeaders(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilenamePart(filename)}"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function sendJsonAttachment(res: Response, filename: string, payload: unknown): void {
  setJsonAttachmentHeaders(res, filename);
  res.send(jsonStringify(payload, 2));
}

/**
 * Schreibt mit Backpressure in die HTTP-Antwort. Bei abgebrochenem Download
 * wird false geliefert, damit nachfolgende DB-Seiten nicht weiter geladen
 * werden. Dadurch bleiben grosse Audit-Exporte serverseitig speicherstabil.
 */
async function writeChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;

  return new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const finish = (ok: boolean): void => {
      cleanup();
      resolve(ok);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);

    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
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

/**
 * Sensibler Audit-Logexport mit stabiler Cursor-Pagination, Hard-Cap und
 * serverseitigem Streaming. Es wird bewusst keine 50k-Zeilen-Liste im RAM
 * aufgebaut; jede DB-Seite wird unmittelbar in die Download-Antwort geschrieben.
 */
devSecureExportRouter.post('/logs', async (req, res) => {
  const category = String(req.body?.category ?? 'ALL').toUpperCase();
  if (!ALLOWED_AUDIT_CATEGORIES.has(category)) { res.status(400).json({ error: 'Ungültige Audit-Kategorie.' }); return; }
  const rawDays = Number(req.body?.days ?? 30);
  if (!Number.isInteger(rawDays) || rawDays < 1 || rawDays > 365) { res.status(400).json({ error: 'days muss 1..365 sein.' }); return; }
  const since = new Date(Date.now() - rawDays * 86_400_000);
  const where: Prisma.AuditLogWhereInput = { createdAt: { gte: since } };
  if (category !== 'ALL') where.category = category as Prisma.AuditLogWhereInput['category'];

  setJsonAttachmentHeaders(res, `audit_logs_${category}_${rawDays}d_${Date.now()}.json`);

  let cursor: string | undefined;
  let count = 0;
  let first = true;
  let completed = true;

  if (!(await writeChunk(res, '['))) return;

  while (count < MAX_ROWS) {
    const page = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(AUDIT_PAGE_SIZE, MAX_ROWS - count),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;

    for (const row of page) {
      const prefix = first ? '\n  ' : ',\n  ';
      if (!(await writeChunk(res, prefix + jsonStringify(row)))) {
        completed = false;
        break;
      }
      first = false;
      count += 1;
    }
    if (!completed) break;

    cursor = page[page.length - 1].id;
    if (page.length < AUDIT_PAGE_SIZE) break;
  }

  if (!completed || res.destroyed || res.writableEnded) {
    logDevAction('LOG_EXPORT_ABORTED', req, {
      category, days: rawDays, count,
      reason: String(req.body?.reason ?? ''),
    });
    return;
  }

  if (!(await writeChunk(res, first ? ']\n' : '\n]\n'))) return;

  logDevAction('LOG_EXPORT', req, {
    category, days: rawDays, count,
    reason: String(req.body?.reason ?? ''), capped: count >= MAX_ROWS,
  });
  res.end();
});
