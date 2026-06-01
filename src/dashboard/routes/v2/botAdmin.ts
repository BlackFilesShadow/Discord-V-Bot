/**
 * Bot-Admin-Bereich (Dashboard) — separater, geschuetzter Support-Bereich.
 *
 * WICHTIG: Das ist NICHT der DEV-Bereich. Der DEV-Bereich bleibt fuer
 * Entwickler/Debug/DB/Eval/Reload/technische Analyse. Dieser Bereich buendelt
 * die frueheren `/admin-*`-Discord-Commands (Appeals, Feedback, Broadcast,
 * Upload-Steuerung, Export, Validierung, Pakete, Nutzer, Tickets, Selfroles,
 * Feeds, Uebersetzungen, XP, Gefahrenzone) als Dashboard-Funktionen.
 *
 * Mount-Punkt: /api/v2/guilds/:guildId/bot-admin/*
 *
 * Berechtigungen (delegierbar, ueber das Permissions-Panel vergebbar):
 *   - GET / Ansicht        -> bot.view
 *   - normale Aktionen     -> bot.manage
 *   - gefaehrliche Aktionen -> bot.danger  (zusaetzlich Confirm-Dialog im UI)
 * Owner hat immer Vollzugriff; `dashboard.access` deckt bot.view/manage/danger ab.
 *
 * Datenscope: Viele Admin-Modelle (Appeal, Feedback, Package, User, Ticket)
 * sind GLOBAL (nicht guild-gebunden) — der :guildId-Pfad dient hier primaer der
 * Permission-Pruefung. Guild-gebundene Modelle (Feed, SelfRoleMenu,
 * TranslatedPost, LevelRole) werden strikt per `scope.guildId` gefiltert.
 *
 * SICHERHEIT: Es werden NIEMALS Secrets ausgegeben (DEV_PASSWORD, Nitrado-Token,
 * OAuth-/Session-Secrets, Encryption-Keys, API-Keys, rohe Authorization-Header).
 * Jede Mutation schreibt ein DB-Audit-Log (logAuditDb).
 */
import { Router, type Request } from 'express';
import { requireGuildPermission } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAuditDb, logger } from '../../../utils/logger';
import { hasPermission } from '../../../types/scope';
import { tryGetDashboardClient } from '../../clientRegistry';
import { approveManufacturer, denyManufacturer } from '../../../modules/registration/register';
import { generateOneTimePassword, hashPassword } from '../../../utils/password';
import { validateFile } from '../../../utils/validator';
import { safeDm } from '../../../utils/safeSend';
import { createFeed } from '../../../modules/feeds/feedManager';
import { getMenuFull, publishMenu } from '../../../modules/selfrole/selfRoleMenu';
import { closeTicket } from '../../../modules/ticket/ticketManager';
import { translate } from '../../../modules/ai/translator';
import type { TextChannel } from 'discord.js';

export const botAdminRouter = Router({ mergeParams: true });

const SNOWFLAKE_RE = /^\d{17,20}$/;
const MAX_PAGE_SIZE = 100;
const MAX_BROADCAST = 1000;
const MAX_EXPORT_ROWS = 5000;

// ── Permission-Shortcuts ──────────────────────────────────────────────────
const view = requireGuildPermission('bot.view');
const manage = requireGuildPermission('bot.manage');
const danger = requireGuildPermission('bot.danger');

// ── Helfer ────────────────────────────────────────────────────────────────
/** Darf der aktuelle Actor gefaehrliche Aktionen ausfuehren? (Owner ODER bot.danger) */
function canDanger(req: Request): boolean {
  return !!req.guildScope && hasPermission(req.guildScope, 'bot.danger');
}

function audit(
  req: Request,
  action: string,
  details: Record<string, unknown>,
  opts: { category?: string; targetUserId?: string | null; channelId?: string | null } = {},
): void {
  const scope = req.guildScope!;
  logAuditDb(action, opts.category ?? 'ADMIN', {
    actorUserId: req.auth!.userId,
    guildId: scope.guildId,
    targetUserId: opts.targetUserId ?? null,
    channelId: opts.channelId ?? null,
    details,
    ip: req.ip,
    userAgent: req.get('user-agent') ?? null,
  });
}

function parsePage(req: Request): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(String(req.query.pageSize ?? '25'), 10) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

async function getBotConfig<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.botConfig.findUnique({ where: { key } });
  return row ? (row.value as unknown as T) : fallback;
}

// ════════════════════════════════════════════════════════════════════════
// ÜBERSICHT
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/overview', view, async (req, res) => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [openAppeals, newFeedback, pendingValidations, uploadEnabled, suspendedUsers, deletedPackages] =
      await Promise.all([
        prisma.appeal.count({ where: { status: 'PENDING' } }),
        prisma.feedback.count({ where: { status: 'OPEN' } }),
        prisma.upload.count({ where: { validationStatus: 'PENDING', isDeleted: false } }),
        getBotConfig<boolean>('upload.enabled', true),
        prisma.user.count({ where: { status: 'SUSPENDED' } }),
        prisma.package.count({ where: { isDeleted: true } }),
      ]);

    const [recentBroadcasts, recentExports, recentAdminActions, criticalWarnings] = await Promise.all([
      prisma.auditLog.findMany({
        where: { action: 'BOTADMIN_BROADCAST_SENT' },
        orderBy: { createdAt: 'desc' }, take: 5,
        select: { id: true, action: true, details: true, createdAt: true },
      }),
      prisma.auditLog.findMany({
        where: { action: { startsWith: 'BOTADMIN_EXPORT_' } },
        orderBy: { createdAt: 'desc' }, take: 5,
        select: { id: true, action: true, details: true, createdAt: true },
      }),
      prisma.auditLog.findMany({
        where: { category: 'ADMIN' },
        orderBy: { createdAt: 'desc' }, take: 10,
        select: { id: true, action: true, actorId: true, details: true, createdAt: true },
      }),
      prisma.securityEvent.count({
        where: { severity: { in: ['HIGH', 'CRITICAL'] }, createdAt: { gte: since } },
      }),
    ]);

    res.json({
      stats: { openAppeals, newFeedback, pendingValidations, uploadEnabled, suspendedUsers, deletedPackages, criticalWarnings },
      recentBroadcasts, recentExports, recentAdminActions,
      quickLinks: ['appeals', 'feedback', 'broadcast', 'validate', 'packages', 'users', 'danger'],
    });
  } catch (e) {
    logger.error('botAdmin overview', { err: (e as Error).message });
    res.status(500).json({ error: 'Übersicht konnte nicht geladen werden.' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// APPEALS  (frueher /admin-appeals)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/appeals', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const where = status && ['PENDING', 'APPROVED', 'DENIED', 'ESCALATED'].includes(status)
    ? { status: status as 'PENDING' | 'APPROVED' | 'DENIED' | 'ESCALATED' } : {};
  const [items, total] = await Promise.all([
    prisma.appeal.findMany({
      where, orderBy: { createdAt: 'desc' }, skip, take: pageSize,
      include: { user: { select: { id: true, discordId: true, username: true } }, case: { select: { id: true, reason: true, action: true } } },
    }),
    prisma.appeal.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

botAdminRouter.get('/appeals/:id', view, async (req, res) => {
  const appeal = await prisma.appeal.findUnique({
    where: { id: String(req.params.id) },
    include: { user: { select: { id: true, discordId: true, username: true } }, case: true },
  });
  if (!appeal) { res.status(404).json({ error: 'Appeal nicht gefunden.' }); return; }
  res.json(appeal);
});

botAdminRouter.post('/appeals/:id/decision', manage, async (req, res) => {
  const decision = String(req.body?.decision ?? '').toUpperCase();
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 1000) : null;
  if (!['APPROVED', 'DENIED', 'ESCALATED'].includes(decision)) {
    res.status(400).json({ error: 'decision muss APPROVED, DENIED oder ESCALATED sein.' }); return;
  }
  const appeal = await prisma.appeal.findUnique({ where: { id: String(req.params.id) } });
  if (!appeal) { res.status(404).json({ error: 'Appeal nicht gefunden.' }); return; }

  const updated = await prisma.appeal.update({
    where: { id: appeal.id },
    data: { status: decision as 'APPROVED' | 'DENIED' | 'ESCALATED', reviewNote: note, reviewedBy: req.guildScope!.actorDiscordId, reviewedAt: new Date() },
  });
  // Bei Genehmigung: zugehoerigen Moderations-Case aufheben.
  if (decision === 'APPROVED') {
    await prisma.moderationCase.update({ where: { id: appeal.caseId }, data: { isActive: false } }).catch(() => null);
  }
  audit(req, 'BOTADMIN_APPEAL_DECISION', { appealId: appeal.id, decision, note }, { category: 'APPEAL', targetUserId: appeal.userId });
  res.json(updated);
});

// ════════════════════════════════════════════════════════════════════════
// FEEDBACK  (frueher /admin-feedback)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/feedback', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const category = typeof req.query.category === 'string' ? req.query.category.toUpperCase() : undefined;
  const where: Record<string, unknown> = {};
  if (status && ['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX'].includes(status)) where.status = status;
  if (category && ['BUG', 'IDEA', 'PRAISE', 'OTHER'].includes(category)) where.category = category;
  const [items, total] = await Promise.all([
    prisma.feedback.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
    prisma.feedback.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

botAdminRouter.get('/feedback/:id', view, async (req, res) => {
  const fb = await prisma.feedback.findUnique({ where: { id: String(req.params.id) } });
  if (!fb) { res.status(404).json({ error: 'Feedback nicht gefunden.' }); return; }
  res.json(fb);
});

botAdminRouter.patch('/feedback/:id', manage, async (req, res) => {
  const fb = await prisma.feedback.findUnique({ where: { id: String(req.params.id) } });
  if (!fb) { res.status(404).json({ error: 'Feedback nicht gefunden.' }); return; }
  const data: Record<string, unknown> = { reviewedBy: req.guildScope!.actorDiscordId, reviewedAt: new Date() };
  if (typeof req.body?.status === 'string') {
    const s = req.body.status.toUpperCase();
    if (!['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX'].includes(s)) { res.status(400).json({ error: 'Ungültiger Status.' }); return; }
    data.status = s;
  }
  if (typeof req.body?.adminNote === 'string') data.adminNote = req.body.adminNote.slice(0, 2000);
  const updated = await prisma.feedback.update({ where: { id: fb.id }, data });
  audit(req, 'BOTADMIN_FEEDBACK_UPDATE', { feedbackId: fb.id, status: data.status, hasNote: !!data.adminNote }, { category: 'ADMIN' });
  res.json(updated);
});

// ════════════════════════════════════════════════════════════════════════
// BROADCAST  (frueher /admin-broadcast) — ALL-Zielgruppe ist gefaehrlich
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/broadcast', view, async (req, res) => {
  const recent = await prisma.auditLog.findMany({
    where: { action: 'BOTADMIN_BROADCAST_SENT' }, orderBy: { createdAt: 'desc' }, take: 10,
    select: { id: true, details: true, createdAt: true },
  });
  res.json({ targets: ['ALL', 'MANUFACTURER', 'ADMIN', 'MODERATOR'], recent, maxRecipients: MAX_BROADCAST });
});

botAdminRouter.post('/broadcast', manage, async (req, res) => {
  const target = String(req.body?.target ?? '').toUpperCase();
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  const dryRun = req.body?.dryRun === true;
  if (!['ALL', 'MANUFACTURER', 'ADMIN', 'MODERATOR'].includes(target)) { res.status(400).json({ error: 'Ungültige Zielgruppe.' }); return; }
  if (message.length < 1 || message.length > 1900) { res.status(400).json({ error: 'Nachricht 1..1900 Zeichen.' }); return; }
  // ALL ist gefaehrlich (potenziell hunderte DMs) -> bot.danger erforderlich.
  if (target === 'ALL' && !canDanger(req)) { res.status(403).json({ error: 'Broadcast an ALLE erfordert die Berechtigung bot.danger.' }); return; }

  const where: Record<string, unknown> = { status: 'ACTIVE' };
  if (target === 'MANUFACTURER') where.OR = [{ role: 'MANUFACTURER' }, { isManufacturer: true }];
  else if (target === 'ADMIN') where.role = 'ADMIN';
  else if (target === 'MODERATOR') where.role = 'MODERATOR';

  const users = await prisma.user.findMany({ where, select: { discordId: true }, take: MAX_BROADCAST });
  if (dryRun) { res.json({ dryRun: true, recipients: users.length, target }); return; }

  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Discord-Client nicht verfügbar.' }); return; }

  let sent = 0, failed = 0;
  for (const u of users) {
    try {
      const discordUser = await client.users.fetch(u.discordId).catch(() => null);
      if (!discordUser) { failed++; continue; }
      const ok = await safeDm(discordUser, message);
      if (ok) sent++; else failed++;
    } catch { failed++; }
  }
  audit(req, 'BOTADMIN_BROADCAST_SENT', { target, recipients: users.length, sent, failed }, { category: 'ADMIN' });
  res.json({ target, recipients: users.length, sent, failed });
});

// ════════════════════════════════════════════════════════════════════════
// UPLOAD-STEUERUNG  (globaler Schalter)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/upload', view, async (_req, res) => {
  const [enabled, maxSize, allowedTypes] = await Promise.all([
    getBotConfig<boolean>('upload.enabled', true),
    getBotConfig<number>('upload.maxSize', 0),
    getBotConfig<string[]>('upload.allowedTypes', ['.xml', '.json']),
  ]);
  res.json({ enabled, maxSize, allowedTypes });
});

botAdminRouter.post('/upload/toggle', manage, async (req, res) => {
  const enable = req.body?.enable === true;
  await prisma.botConfig.upsert({
    where: { key: 'upload.enabled' },
    update: { value: enable as never, updatedBy: req.guildScope!.actorDiscordId },
    create: { key: 'upload.enabled', value: enable as never, category: 'upload', updatedBy: req.guildScope!.actorDiscordId },
  });
  audit(req, 'BOTADMIN_UPLOAD_TOGGLE', { enabled: enable }, { category: 'CONFIG' });
  res.json({ enabled: enable });
});

// ════════════════════════════════════════════════════════════════════════
// EXPORT  (frueher /admin-export) — Nutzer/GDPR-Export ist gefaehrlich
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/export', view, async (_req, res) => {
  res.json({ types: ['packages', 'logs', 'users'], note: 'users/GDPR-Export erfordert bot.danger.' });
});

botAdminRouter.post('/export', manage, async (req, res) => {
  const type = String(req.body?.type ?? '');
  if (!['packages', 'logs', 'users'].includes(type)) { res.status(400).json({ error: 'type muss packages, logs oder users sein.' }); return; }
  if (type === 'users' && !canDanger(req)) { res.status(403).json({ error: 'Nutzer-/GDPR-Export erfordert bot.danger.' }); return; }

  let data: unknown[];
  if (type === 'packages') {
    const rows = await prisma.package.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_EXPORT_ROWS, include: { user: { select: { discordId: true, username: true } } } });
    data = rows.map((p) => ({ id: p.id, name: p.name, status: p.status, totalSize: p.totalSize.toString(), fileCount: p.fileCount, downloadCount: p.downloadCount, owner: p.user.username, createdAt: p.createdAt }));
  } else if (type === 'logs') {
    data = await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_EXPORT_ROWS, select: { id: true, action: true, category: true, actorId: true, targetId: true, guildId: true, createdAt: true } });
  } else {
    const rows = await prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_EXPORT_ROWS, select: { id: true, discordId: true, username: true, role: true, status: true, isManufacturer: true, createdAt: true } });
    data = rows;
  }
  audit(req, `BOTADMIN_EXPORT_${type.toUpperCase()}`, { type, rows: data.length }, { category: type === 'users' ? 'GDPR' : 'ADMIN' });
  res.json({ type, rows: data.length, data });
});

// ════════════════════════════════════════════════════════════════════════
// VALIDIERUNG  (frueher /admin-validate)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/validate', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const [pending, recent, total] = await Promise.all([
    prisma.upload.count({ where: { validationStatus: 'PENDING', isDeleted: false } }),
    prisma.validationResult.findMany({ orderBy: { createdAt: 'desc' }, skip, take: pageSize, include: { upload: { select: { fileName: true, originalName: true } } } }),
    prisma.validationResult.count(),
  ]);
  res.json({ pendingUploads: pending, items: recent, total, page, pageSize });
});

botAdminRouter.post('/validate', manage, async (req, res) => {
  const uploadId = typeof req.body?.uploadId === 'string' ? req.body.uploadId : null;
  if (!uploadId) { res.status(400).json({ error: 'uploadId fehlt.' }); return; }
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) { res.status(404).json({ error: 'Upload nicht gefunden.' }); return; }
  try {
    const report = await validateFile(upload.filePath);
    const status = report.isValid ? 'VALID' : 'INVALID';
    await prisma.upload.update({ where: { id: upload.id }, data: { validationStatus: status, isValid: report.isValid } });
    await prisma.validationResult.create({
      data: { uploadId: upload.id, packageId: upload.packageId, isValid: report.isValid, errors: report.errors as never, warnings: report.warnings as never, suggestions: report.suggestions as never, validatedBy: req.guildScope!.actorDiscordId },
    });
    audit(req, 'BOTADMIN_VALIDATE', { uploadId: upload.id, isValid: report.isValid }, { category: 'UPLOAD' });
    res.json({ uploadId: upload.id, report });
  } catch (e) {
    await prisma.upload.update({ where: { id: upload.id }, data: { validationStatus: 'ERROR' } }).catch(() => null);
    res.status(500).json({ error: 'Validierung fehlgeschlagen.', detail: (e as Error).message });
  }
});

// ════════════════════════════════════════════════════════════════════════
// PAKETE  (frueher /admin-list-pakete/approve/deny/delete)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/packages', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where: Record<string, unknown> = {};
  if (status && ['ACTIVE', 'QUARANTINED', 'DELETED', 'VALIDATING'].includes(status)) where.status = status;
  if (q) where.name = { contains: q, mode: 'insensitive' };
  const [items, total] = await Promise.all([
    prisma.package.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize, include: { user: { select: { discordId: true, username: true } } } }),
    prisma.package.count({ where }),
  ]);
  res.json({ items: items.map((p) => ({ ...p, totalSize: p.totalSize.toString() })), total, page, pageSize });
});

botAdminRouter.get('/packages/:id', view, async (req, res) => {
  const pkg = await prisma.package.findUnique({
    where: { id: String(req.params.id) },
    include: { user: { select: { discordId: true, username: true } }, files: { select: { id: true, fileName: true, originalName: true, fileSize: true, validationStatus: true, isQuarantined: true, isDeleted: true } } },
  });
  if (!pkg) { res.status(404).json({ error: 'Paket nicht gefunden.' }); return; }
  res.json({ ...pkg, totalSize: pkg.totalSize.toString(), files: pkg.files.map((f) => ({ ...f, fileSize: f.fileSize.toString() })) });
});

botAdminRouter.post('/packages/:id/status', manage, async (req, res) => {
  const status = String(req.body?.status ?? '').toUpperCase();
  if (!['ACTIVE', 'QUARANTINED'].includes(status)) { res.status(400).json({ error: 'status muss ACTIVE oder QUARANTINED sein.' }); return; }
  const pkg = await prisma.package.findUnique({ where: { id: String(req.params.id) } });
  if (!pkg) { res.status(404).json({ error: 'Paket nicht gefunden.' }); return; }
  const updated = await prisma.package.update({ where: { id: pkg.id }, data: { status: status as 'ACTIVE' | 'QUARANTINED' } });
  audit(req, 'BOTADMIN_PACKAGE_STATUS', { packageId: pkg.id, status }, { category: 'ADMIN' });
  res.json({ ...updated, totalSize: updated.totalSize.toString() });
});

botAdminRouter.post('/packages/:id/restore', manage, async (req, res) => {
  const pkg = await prisma.package.findUnique({ where: { id: String(req.params.id) } });
  if (!pkg) { res.status(404).json({ error: 'Paket nicht gefunden.' }); return; }
  const updated = await prisma.package.update({ where: { id: pkg.id }, data: { isDeleted: false, deletedAt: null, deletedBy: null, status: 'ACTIVE' } });
  audit(req, 'BOTADMIN_PACKAGE_RESTORE', { packageId: pkg.id }, { category: 'ADMIN' });
  res.json({ ...updated, totalSize: updated.totalSize.toString() });
});

// Loeschen = gefaehrlich (Soft-Delete; ?hard=true entfernt DB-Datensatz endgueltig)
botAdminRouter.delete('/packages/:id', danger, async (req, res) => {
  const hard = req.query.hard === 'true';
  const pkg = await prisma.package.findUnique({ where: { id: String(req.params.id) } });
  if (!pkg) { res.status(404).json({ error: 'Paket nicht gefunden.' }); return; }
  if (hard) {
    await prisma.package.delete({ where: { id: pkg.id } }); // Cascade entfernt Uploads
    audit(req, 'BOTADMIN_PACKAGE_HARD_DELETE', { packageId: pkg.id, name: pkg.name }, { category: 'ADMIN' });
    res.json({ deleted: true, hard: true });
    return;
  }
  await prisma.package.update({ where: { id: pkg.id }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: req.guildScope!.actorDiscordId, status: 'DELETED' } });
  audit(req, 'BOTADMIN_PACKAGE_SOFT_DELETE', { packageId: pkg.id, name: pkg.name }, { category: 'ADMIN' });
  res.json({ deleted: true, hard: false });
});

// ════════════════════════════════════════════════════════════════════════
// NUTZER  (frueher /admin-list-users / toggle-upload / reset-password / approve / deny)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/users', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const filter = typeof req.query.filter === 'string' ? req.query.filter.toUpperCase() : 'ALL';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where: Record<string, unknown> = {};
  if (filter === 'MANUFACTURER') where.OR = [{ role: 'MANUFACTURER' }, { isManufacturer: true }];
  else if (['ADMIN', 'MODERATOR'].includes(filter)) where.role = filter;
  else if (filter === 'BANNED') where.status = 'BANNED';
  else if (filter === 'PENDING_VERIFICATION') where.status = 'PENDING_VERIFICATION';
  if (q) where.AND = [{ OR: [{ username: { contains: q, mode: 'insensitive' } }, { discordId: { contains: q } }] }];
  const [items, total] = await Promise.all([
    prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize, select: { id: true, discordId: true, username: true, role: true, status: true, isManufacturer: true, createdAt: true } }),
    prisma.user.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

botAdminRouter.get('/users/:id', view, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: String(req.params.id) },
    select: { id: true, discordId: true, username: true, role: true, status: true, isManufacturer: true, manufacturerApprovedAt: true, manufacturerApprovedBy: true, createdAt: true, updatedAt: true, _count: { select: { packages: true } } },
  });
  if (!user) { res.status(404).json({ error: 'Nutzer nicht gefunden.' }); return; }
  res.json(user);
});

botAdminRouter.post('/users/:id/toggle-upload', manage, async (req, res) => {
  const enable = req.body?.enable === true;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) { res.status(404).json({ error: 'Nutzer nicht gefunden.' }); return; }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { status: enable ? 'ACTIVE' : 'SUSPENDED' } });
  audit(req, 'BOTADMIN_USER_TOGGLE_UPLOAD', { enabled: enable, reason }, { category: 'ADMIN', targetUserId: user.id });
  res.json({ id: updated.id, status: updated.status });
});

botAdminRouter.post('/users/:id/manufacturer', manage, async (req, res) => {
  const decision = String(req.body?.decision ?? '').toUpperCase();
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) { res.status(404).json({ error: 'Nutzer nicht gefunden.' }); return; }
  if (!['APPROVE', 'DENY'].includes(decision)) { res.status(400).json({ error: 'decision muss APPROVE oder DENY sein.' }); return; }
  const actorDiscordId = req.guildScope!.actorDiscordId;
  const result = decision === 'APPROVE'
    ? await approveManufacturer(user.discordId, actorDiscordId)
    : await denyManufacturer(user.discordId, actorDiscordId, note);
  if (!result.success) { res.status(400).json({ error: result.message }); return; }
  audit(req, 'BOTADMIN_USER_MANUFACTURER', { decision }, { category: 'REGISTRATION', targetUserId: user.id });
  // Bei Approve enthaelt result ein Einmal-Passwort (OTP) — bewusst EINMALIG an den Admin
  // zurueckgegeben, damit dieser es dem Nutzer weiterreichen kann. Kein dauerhaftes Secret.
  res.json({ success: true, message: result.message, otp: decision === 'APPROVE' ? (result as { otp?: string }).otp : undefined });
});

// Passwort-Reset = gefaehrlich. OTP wird EINMALIG zurueckgegeben.
botAdminRouter.post('/users/:id/reset-password', danger, async (req, res) => {
  const expiryMinutes = Math.min(1440, Math.max(5, parseInt(String(req.body?.expiryMinutes ?? 30), 10) || 30));
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) { res.status(404).json({ error: 'Nutzer nicht gefunden.' }); return; }
  const otp = generateOneTimePassword(48);
  const otpHash = await hashPassword(otp);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
  await prisma.oneTimePassword.updateMany({ where: { userId: user.id, isUsed: false, isRevoked: false }, data: { isRevoked: true } });
  await prisma.oneTimePassword.create({ data: { userId: user.id, passwordHash: otpHash, expiresAt } });
  audit(req, 'BOTADMIN_USER_RESET_PASSWORD', { expiryMinutes }, { category: 'ADMIN', targetUserId: user.id });
  res.json({ success: true, otp, expiresAt });
});

// ════════════════════════════════════════════════════════════════════════
// TICKETS  (frueher /admin-tickets — Bot-Support-Tickets, NICHT Guild-Templates)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/tickets', view, async (req, res) => {
  const { page, pageSize, skip } = parsePage(req);
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
  const where = status && ['PENDING', 'OPEN', 'DENIED', 'CLOSED'].includes(status) ? { status: status as 'PENDING' | 'OPEN' | 'DENIED' | 'CLOSED' } : {};
  const [items, total] = await Promise.all([
    prisma.ticket.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize, select: { id: true, ticketNumber: true, userDiscordId: true, username: true, subject: true, status: true, createdAt: true, closedAt: true } }),
    prisma.ticket.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

botAdminRouter.get('/tickets/:id', view, async (req, res) => {
  const ticket = await prisma.ticket.findUnique({ where: { id: String(req.params.id) }, include: { messages: { orderBy: { createdAt: 'asc' } } } });
  if (!ticket) { res.status(404).json({ error: 'Ticket nicht gefunden.' }); return; }
  res.json(ticket);
});

botAdminRouter.post('/tickets/:id/close', manage, async (req, res) => {
  const ticket = await prisma.ticket.findUnique({ where: { id: String(req.params.id) } });
  if (!ticket) { res.status(404).json({ error: 'Ticket nicht gefunden.' }); return; }
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Discord-Client nicht verfügbar.' }); return; }
  const result = await closeTicket(ticket.id, req.guildScope!.actorDiscordId, client);
  if (!result.success) { res.status(400).json({ error: result.message }); return; }
  audit(req, 'BOTADMIN_TICKET_CLOSE', { ticketId: ticket.id, ticketNumber: ticket.ticketNumber }, { category: 'TICKET' });
  res.json({ success: true, message: result.message });
});

// ════════════════════════════════════════════════════════════════════════
// SELFROLES  (frueher /selfrole) — guild-gebunden
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/selfroles', view, async (req, res) => {
  const menus = await prisma.selfRoleMenu.findMany({ where: { guildId: req.guildScope!.guildId }, orderBy: { createdAt: 'desc' }, include: { options: { orderBy: { position: 'asc' } } } });
  res.json({ items: menus });
});

botAdminRouter.post('/selfroles', manage, async (req, res) => {
  const channelId = String(req.body?.channelId ?? '');
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 2000) : null;
  const mode = req.body?.mode === 'SINGLE' ? 'SINGLE' : 'MULTI';
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  if (title.length < 1 || title.length > 120) { res.status(400).json({ error: 'title 1..120 Zeichen.' }); return; }
  const menu = await prisma.selfRoleMenu.create({ data: { guildId: req.guildScope!.guildId, channelId, title, description, mode, createdBy: req.guildScope!.actorDiscordId } });
  audit(req, 'BOTADMIN_SELFROLE_CREATE', { menuId: menu.id, channelId }, { category: 'ROLE', channelId });
  res.status(201).json(menu);
});

botAdminRouter.post('/selfroles/:id/options', manage, async (req, res) => {
  const guildId = req.guildScope!.guildId;
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: String(req.params.id), guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const roleId = String(req.body?.roleId ?? '');
  const label = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
  const emoji = typeof req.body?.emoji === 'string' ? req.body.emoji.slice(0, 64) : null;
  const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 100) : null;
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'Ungültige roleId.' }); return; }
  if (roleId === guildId) { res.status(400).json({ error: '@everyone kann nicht als Selfrole verwendet werden.' }); return; }
  if (label.length < 1 || label.length > 80) { res.status(400).json({ error: 'label 1..80 Zeichen.' }); return; }
  // Rolle gegen die Guild pruefen: managed/Hierarchie.
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  if (guild) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role) { res.status(400).json({ error: 'Rolle nicht gefunden.' }); return; }
    if (role.managed) { res.status(400).json({ error: 'Von Integrationen verwaltete Rollen sind nicht erlaubt.' }); return; }
    const me = guild.members.me;
    if (me && me.roles.highest.position <= role.position) { res.status(400).json({ error: 'Bot-Rolle ist nicht hoch genug, um diese Rolle zu vergeben.' }); return; }
  }
  try {
    const count = await prisma.selfRoleOption.count({ where: { menuId: menu.id } });
    const opt = await prisma.selfRoleOption.create({ data: { menuId: menu.id, roleId, label, emoji, description, position: count } });
    audit(req, 'BOTADMIN_SELFROLE_OPTION_ADD', { menuId: menu.id, roleId }, { category: 'ROLE' });
    res.status(201).json(opt);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') { res.status(409).json({ error: 'Diese Rolle ist bereits im Menü.' }); return; }
    throw e;
  }
});

botAdminRouter.delete('/selfroles/:id/options/:optId', manage, async (req, res) => {
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  await prisma.selfRoleOption.deleteMany({ where: { id: String(req.params.optId), menuId: menu.id } });
  audit(req, 'BOTADMIN_SELFROLE_OPTION_REMOVE', { menuId: menu.id, optionId: String(req.params.optId) }, { category: 'ROLE' });
  res.json({ deleted: true });
});

botAdminRouter.post('/selfroles/:id/post', manage, async (req, res) => {
  const menuRow = await prisma.selfRoleMenu.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!menuRow) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const full = await getMenuFull(menuRow.id);
  if (!full || full.options.length === 0) { res.status(400).json({ error: 'Menü hat keine Optionen.' }); return; }
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(req.guildScope!.guildId);
  const channel = guild?.channels.cache.get(menuRow.channelId);
  if (!channel || !channel.isTextBased()) { res.status(400).json({ error: 'Ziel-Channel nicht gefunden oder kein Text-Channel.' }); return; }
  const messageId = await publishMenu(full, channel as TextChannel);
  audit(req, 'BOTADMIN_SELFROLE_POST', { menuId: menuRow.id, messageId }, { category: 'ROLE', channelId: menuRow.channelId });
  res.json({ messageId });
});

botAdminRouter.post('/selfroles/:id/toggle', manage, async (req, res) => {
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  const updated = await prisma.selfRoleMenu.update({ where: { id: menu.id }, data: { isActive: !menu.isActive } });
  audit(req, 'BOTADMIN_SELFROLE_TOGGLE', { menuId: menu.id, isActive: updated.isActive }, { category: 'ROLE' });
  res.json({ id: updated.id, isActive: updated.isActive });
});

botAdminRouter.delete('/selfroles/:id', manage, async (req, res) => {
  const menu = await prisma.selfRoleMenu.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!menu) { res.status(404).json({ error: 'Menü nicht gefunden.' }); return; }
  await prisma.selfRoleMenu.delete({ where: { id: menu.id } });
  audit(req, 'BOTADMIN_SELFROLE_DELETE', { menuId: menu.id }, { category: 'ROLE' });
  res.json({ deleted: true });
});

// ════════════════════════════════════════════════════════════════════════
// FEEDS  (frueher /feed) — guild-gebunden
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/feeds', view, async (req, res) => {
  const feeds = await prisma.feed.findMany({ where: { guildId: req.guildScope!.guildId }, orderBy: { createdAt: 'desc' } });
  // webhookSecret NIE ausgeben.
  res.json({ items: feeds.map(({ webhookSecret: _omit, ...rest }) => rest) });
});

botAdminRouter.post('/feeds', manage, async (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const feedType = String(req.body?.feedType ?? '').toUpperCase();
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  const channelId = String(req.body?.channelId ?? '');
  const interval = Math.min(86400, Math.max(60, parseInt(String(req.body?.interval ?? 300), 10) || 300));
  if (name.length < 1 || name.length > 100) { res.status(400).json({ error: 'name 1..100 Zeichen.' }); return; }
  if (!['RSS', 'TWITCH', 'TWITTER', 'STEAM', 'NEWS', 'WEBHOOK', 'CUSTOM'].includes(feedType)) { res.status(400).json({ error: 'Ungültiger feedType.' }); return; }
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  if (!url || url.length > 2000) { res.status(400).json({ error: 'Ungültige url.' }); return; }
  const id = await createFeed(name, feedType, url, channelId, interval, req.guildScope!.actorDiscordId, req.guildScope!.guildId);
  audit(req, 'BOTADMIN_FEED_CREATE', { feedId: id, feedType, channelId }, { category: 'FEED', channelId });
  res.status(201).json({ id });
});

botAdminRouter.post('/feeds/:id/toggle', manage, async (req, res) => {
  const feed = await prisma.feed.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!feed) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  const updated = await prisma.feed.update({ where: { id: feed.id }, data: { isActive: !feed.isActive } });
  audit(req, 'BOTADMIN_FEED_TOGGLE', { feedId: feed.id, isActive: updated.isActive }, { category: 'FEED' });
  res.json({ id: updated.id, isActive: updated.isActive });
});

botAdminRouter.delete('/feeds/:id', manage, async (req, res) => {
  const feed = await prisma.feed.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!feed) { res.status(404).json({ error: 'Feed nicht gefunden.' }); return; }
  await prisma.feed.delete({ where: { id: feed.id } });
  audit(req, 'BOTADMIN_FEED_DELETE', { feedId: feed.id }, { category: 'FEED' });
  res.json({ deleted: true });
});

// ════════════════════════════════════════════════════════════════════════
// ÜBERSETZUNGEN  (frueher /translate-post) — guild-gebunden
// ════════════════════════════════════════════════════════════════════════
const LANGS = ['de', 'en', 'fr', 'ar', 'ko', 'es', 'it', 'pt', 'ru', 'tr'];

botAdminRouter.get('/translate', view, async (req, res) => {
  const posts = await prisma.translatedPost.findMany({ where: { guildId: req.guildScope!.guildId }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ items: posts, languages: LANGS });
});

botAdminRouter.post('/translate', manage, async (req, res) => {
  const sourceText = typeof req.body?.sourceText === 'string' ? req.body.sourceText.trim() : '';
  const targetLang = String(req.body?.targetLang ?? '').toLowerCase();
  const channelId = String(req.body?.channelId ?? '');
  const customTitle = typeof req.body?.customTitle === 'string' ? req.body.customTitle.slice(0, 200) : null;
  if (sourceText.length < 1 || sourceText.length > 4000) { res.status(400).json({ error: 'sourceText 1..4000 Zeichen.' }); return; }
  if (!LANGS.includes(targetLang)) { res.status(400).json({ error: 'Ungültige Zielsprache.' }); return; }
  if (!SNOWFLAKE_RE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  const translated = await translate(sourceText, targetLang);
  if (!translated) { res.status(502).json({ error: 'Übersetzung fehlgeschlagen (AI nicht verfügbar).' }); return; }
  const post = await prisma.translatedPost.create({
    data: { guildId: req.guildScope!.guildId, channelId, createdBy: req.guildScope!.actorDiscordId, sourceText, sourceLang: 'auto', targetLang, translatedText: translated, customTitle, mode: 'now' },
  });
  audit(req, 'BOTADMIN_TRANSLATE_CREATE', { postId: post.id, targetLang, channelId }, { category: 'AI', channelId });
  res.status(201).json(post);
});

botAdminRouter.delete('/translate/:id', manage, async (req, res) => {
  const post = await prisma.translatedPost.findFirst({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  if (!post) { res.status(404).json({ error: 'Eintrag nicht gefunden.' }); return; }
  await prisma.translatedPost.delete({ where: { id: post.id } });
  audit(req, 'BOTADMIN_TRANSLATE_DELETE', { postId: post.id }, { category: 'AI' });
  res.json({ deleted: true });
});

// ════════════════════════════════════════════════════════════════════════
// XP-SYSTEM  (frueher /xp-config) — XpConfig global, LevelRole guild-gebunden
// ════════════════════════════════════════════════════════════════════════
async function getOrCreateXpConfig() {
  const existing = await prisma.xpConfig.findFirst();
  if (existing) return existing;
  return prisma.xpConfig.create({ data: {} });
}

botAdminRouter.get('/xp', view, async (req, res) => {
  const [config, levelRoles] = await Promise.all([
    getOrCreateXpConfig(),
    prisma.levelRole.findMany({ where: { guildId: req.guildScope!.guildId }, orderBy: { level: 'asc' } }),
  ]);
  res.json({ config, levelRoles });
});

botAdminRouter.patch('/xp', manage, async (req, res) => {
  const config = await getOrCreateXpConfig();
  const data: Record<string, unknown> = {};
  const numFields: Array<[string, number, number]> = [
    ['messageXpMin', 0, 1000], ['messageXpMax', 0, 1000], ['voiceXpPerMinute', 0, 1000],
    ['eventXpBonus', 0, 10000], ['xpCooldownSeconds', 0, 86400], ['maxLevel', 1, 1000],
  ];
  for (const [field, min, max] of numFields) {
    if (req.body?.[field] !== undefined) {
      const v = parseInt(String(req.body[field]), 10);
      if (!Number.isInteger(v) || v < min || v > max) { res.status(400).json({ error: `${field} muss ${min}..${max} sein.` }); return; }
      data[field] = v;
    }
  }
  if (req.body?.levelMultiplier !== undefined) {
    const v = Number(req.body.levelMultiplier);
    if (!Number.isFinite(v) || v <= 0 || v > 100) { res.status(400).json({ error: 'levelMultiplier 0..100.' }); return; }
    data.levelMultiplier = v;
  }
  if (req.body?.isActive !== undefined) data.isActive = req.body.isActive === true;
  if (req.body?.maxLevelRoleId !== undefined) {
    const r = req.body.maxLevelRoleId;
    if (r !== null && !SNOWFLAKE_RE.test(String(r))) { res.status(400).json({ error: 'Ungültige maxLevelRoleId.' }); return; }
    data.maxLevelRoleId = r === null ? null : String(r);
  }
  const updated = await prisma.xpConfig.update({ where: { id: config.id }, data });
  audit(req, 'BOTADMIN_XP_UPDATE', { fields: Object.keys(data) }, { category: 'LEVEL' });
  res.json(updated);
});

botAdminRouter.post('/xp/level-roles', manage, async (req, res) => {
  const level = parseInt(String(req.body?.level ?? ''), 10);
  const roleId = String(req.body?.roleId ?? '');
  if (!Number.isInteger(level) || level < 1 || level > 1000) { res.status(400).json({ error: 'level 1..1000.' }); return; }
  if (!SNOWFLAKE_RE.test(roleId)) { res.status(400).json({ error: 'Ungültige roleId.' }); return; }
  try {
    const lr = await prisma.levelRole.create({ data: { guildId: req.guildScope!.guildId, level, roleId } });
    audit(req, 'BOTADMIN_XP_LEVELROLE_ADD', { level, roleId }, { category: 'LEVEL' });
    res.status(201).json(lr);
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') { res.status(409).json({ error: 'Für dieses Level existiert bereits eine Rolle.' }); return; }
    throw e;
  }
});

botAdminRouter.delete('/xp/level-roles/:id', manage, async (req, res) => {
  await prisma.levelRole.deleteMany({ where: { id: String(req.params.id), guildId: req.guildScope!.guildId } });
  audit(req, 'BOTADMIN_XP_LEVELROLE_REMOVE', { id: String(req.params.id) }, { category: 'LEVEL' });
  res.json({ deleted: true });
});

// ════════════════════════════════════════════════════════════════════════
// GEFAHRENZONE  (gebuendelte gefaehrliche Aktionen)
// ════════════════════════════════════════════════════════════════════════
botAdminRouter.get('/danger', view, async (_req, res) => {
  const [softDeletedPackages, suspendedUsers, recentDangerActions] = await Promise.all([
    prisma.package.count({ where: { isDeleted: true } }),
    prisma.user.count({ where: { status: 'SUSPENDED' } }),
    prisma.auditLog.findMany({
      where: { action: { in: ['BOTADMIN_PACKAGE_HARD_DELETE', 'BOTADMIN_USER_RESET_PASSWORD', 'BOTADMIN_DANGER_PURGE_PACKAGES', 'BOTADMIN_BROADCAST_SENT'] } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, action: true, actorId: true, details: true, createdAt: true },
    }),
  ]);
  res.json({ softDeletedPackages, suspendedUsers, recentDangerActions });
});

// Endgueltiges Loeschen aller soft-geloeschten Pakete. Confirm "DELETE" erforderlich.
botAdminRouter.post('/danger/purge-deleted-packages', danger, async (req, res) => {
  if (req.body?.confirm !== 'DELETE') { res.status(400).json({ error: 'Bestätigung "DELETE" erforderlich.' }); return; }
  const result = await prisma.package.deleteMany({ where: { isDeleted: true } });
  audit(req, 'BOTADMIN_DANGER_PURGE_PACKAGES', { count: result.count }, { category: 'ADMIN' });
  res.json({ purged: result.count });
});
