/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: intentional cross-tenant system/admin surface (authZ outside Prisma where). */
import { Router, type Response } from 'express';
import { requireBotAdmin } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAudit, logAuditDb } from '../../../utils/logger';

const MAX_ROWS = 50_000;
const PAGE_SIZE = 1000;

export const botAdminAuditExportRouter = Router();
botAdminAuditExportRouter.use(requireBotAdmin);

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, current) => typeof current === 'bigint' ? current.toString() : current);
}

async function writeChunk(res: Response, chunk: string): Promise<boolean> {
  if (res.destroyed || res.writableEnded) return false;
  if (res.write(chunk)) return true;
  return new Promise<boolean>((resolve) => {
    const cleanup = (): void => {
      res.off('drain', onDrain);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const finish = (ok: boolean): void => { cleanup(); resolve(ok); };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onError = (): void => finish(false);
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
  });
}

botAdminAuditExportRouter.get('/', async (req, res) => {
  const rawDays = Number(req.query.days ?? 30);
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.trunc(rawDays))) : 30;
  const since = new Date(Date.now() - days * 86_400_000);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit_export_${days}d_${Date.now()}.json"`);
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  let cursor: string | undefined;
  let count = 0;
  let first = true;
  let aborted = false;

  if (!(await writeChunk(res, '['))) return;

  while (count < MAX_ROWS) {
    const page = await prisma.auditLog.findMany({
      where: { createdAt: { gte: since } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: Math.min(PAGE_SIZE, MAX_ROWS - count),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (page.length === 0) break;

    for (const row of page) {
      if (!(await writeChunk(res, `${first ? '\n  ' : ',\n  '}${stringify(row)}`))) {
        aborted = true;
        break;
      }
      first = false;
      count += 1;
    }
    if (aborted) break;
    cursor = page[page.length - 1].id;
    if (page.length < PAGE_SIZE) break;
  }

  const details = {
    days,
    count,
    capped: count >= MAX_ROWS,
    aborted,
    by: req.auth?.discordId ?? req.auth?.userId ?? 'dashboard',
  };

  if (aborted || res.destroyed || res.writableEnded) {
    logAudit('BOTADMIN_AUDIT_EXPORT_ABORTED', 'ADMIN', details);
    return;
  }

  if (!(await writeChunk(res, first ? ']\n' : '\n]\n'))) return;
  logAudit('BOTADMIN_AUDIT_EXPORT', 'ADMIN', details);
  logAuditDb('BOTADMIN_AUDIT_EXPORT', 'ADMIN', {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
  res.end();
});
