import { Router } from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EmbedBuilder, type TextChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import { requireBotAdmin } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logger, logAudit, logAuditDb } from '../../../utils/logger';
import { tryGetDashboardClient } from '../../clientRegistry';
import { config } from '../../../config';
import { validateFile } from '../../../utils/validator';
import { withTimeout } from '../../../utils/safeSend';
import { isInsideUploadRoot } from '../../../utils/pathSafety';
import {
  ALL_PROVIDERS,
  type ProviderName,
  getStats,
  getRankedProviders,
  probeProvider,
  getAllCooldowns,
  clearCooldown,
} from '../../../modules/ai/providerStats';
import {
  listTriggers,
  addTrigger,
  removeTrigger,
  clearTriggers,
  MAX_TRIGGERS_PER_GUILD,
  GLOBAL_AI_TRIGGERS,
  type AiTrigger,
} from '../../../modules/ai/triggers';
import { saveRemoteMedia, deleteMediaIfLocal, MAX_MEDIA_BYTES, MEDIA_BASE_DIR } from '../../../modules/ai/mediaStorage';
import { resolveCustomEmotes } from '../../../modules/ai/emoteResolver';

/**
 * Vollstaendige Dashboard-Paritaet fuer die noch vorhandenen adminOnly Slash-
 * Commands. Erst wenn diese Routen/UI getestet sind, werden die Discord-
 * Commands entfernt. Alle Routen verlangen eine aktive BotAdminSession.
 */
export const botAdminCommandCenterRouter = Router();
botAdminCommandCenterRouter.use(requireBotAdmin);

const SNOWFLAKE = /^\d{17,20}$/;
const MAX_VALIDATE_BYTES = 50 * 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 30_000;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|mp4|webm|mov)$/i;
const MEDIA_MIME = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|quicktime))$/i;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MEDIA_BYTES, files: 1, fields: 20, parts: 24 } });

function actor(req: Parameters<typeof requireBotAdmin>[0]): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'dashboard');
}

function audit(req: Parameters<typeof requireBotAdmin>[0], action: string, category: string, details: Record<string, unknown>): void {
  const by = actor(req);
  logAudit(action, category as never, { ...details, by });
  logAuditDb(action, category as never, {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
}

function guildIdFrom(req: Parameters<typeof requireBotAdmin>[0]): string | null {
  const raw = typeof req.query.guildId === 'string' ? req.query.guildId : String(req.body?.guildId ?? '');
  return SNOWFLAKE.test(raw) ? raw : null;
}

function toJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x));
}

// ---------------------------------------------------------------------------
// ADMIN-STATS + ADMIN-MONITOR + ADMIN-ERROR-REPORT
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/overview', async (_req, res) => {
  const start = Date.now();
  let dbOk = true;
  try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }
  const dbLatencyMs = Date.now() - start;
  const [
    totalUsers, manufacturers, totalPackages, activePackages, quarantinedPackages,
    totalUploads, invalidUploads, totalDownloads, totalCases, activeCases,
    pendingAppeals, activeGiveaways, totalPolls, activePolls, activeFeeds,
    activeSessions, securityEvents, unresolvedSecEvents, unresolvedHigh,
  ] = await Promise.all([
    prisma.user.count(), prisma.user.count({ where: { isManufacturer: true } }),
    prisma.package.count(), prisma.package.count({ where: { status: 'ACTIVE' } }),
    prisma.package.count({ where: { status: 'QUARANTINED' } }), prisma.upload.count(),
    prisma.upload.count({ where: { validationStatus: 'INVALID' } }), prisma.download.count(),
    prisma.moderationCase.count(), prisma.moderationCase.count({ where: { isActive: true } }),
    prisma.appeal.count({ where: { status: 'PENDING' } }), prisma.giveaway.count({ where: { status: 'ACTIVE' } }),
    prisma.poll.count(), prisma.poll.count({ where: { status: 'ACTIVE' } }), prisma.feed.count({ where: { isActive: true } }),
    prisma.session.count({ where: { isActive: true, expiresAt: { gt: new Date() } } }),
    prisma.securityEvent.count(), prisma.securityEvent.count({ where: { isResolved: false } }),
    prisma.securityEvent.count({ where: { isResolved: false, severity: { in: ['CRITICAL', 'HIGH'] } } }),
  ]);

  let uploadDir = { exists: false, writable: false, bytes: 0 };
  try {
    await fs.access(config.upload.dir);
    uploadDir.exists = true;
    try { await fs.access(config.upload.dir, 2); uploadDir.writable = true; } catch { /* read-only */ }
    const walk = async (dir: string): Promise<number> => {
      let total = 0;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) total += await walk(full);
        else total += (await fs.stat(full).catch(() => null))?.size ?? 0;
      }
      return total;
    };
    uploadDir.bytes = await walk(config.upload.dir);
  } catch { /* missing */ }

  const client = tryGetDashboardClient();
  const mem = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMemPercent = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const load = os.loadavg()[0] ?? 0;
  const cpuCount = os.cpus().length;
  let healthScore = 100;
  if (!dbOk) healthScore -= 30;
  if (dbLatencyMs > 500) healthScore -= 10;
  if (usedMemPercent > 90) healthScore -= 20;
  if (load > cpuCount * 2) healthScore -= 15;
  if (unresolvedHigh > 0) healthScore -= 10;
  if (!uploadDir.writable) healthScore -= 10;

  res.json({
    healthScore,
    bot: { ready: !!client, pingMs: client?.ws.ping ?? -1, guilds: client?.guilds.cache.size ?? 0, users: client ? client.guilds.cache.reduce((s, g) => s + g.memberCount, 0) : 0, uptimeSec: Math.round(process.uptime()) },
    database: { ok: dbOk, latencyMs: dbLatencyMs },
    system: { load, cpuCount, totalMem, freeMem, usedMemPercent, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss, node: process.version, os: `${os.type()} ${os.release()}` },
    storage: uploadDir,
    usage: { totalUsers, manufacturers, totalPackages, activePackages, quarantinedPackages, totalUploads, invalidUploads, totalDownloads, totalCases, activeCases, pendingAppeals, activeGiveaways, totalPolls, activePolls, activeFeeds, activeSessions, securityEvents, unresolvedSecEvents, unresolvedHigh },
    generatedAt: new Date().toISOString(),
  });
});

botAdminCommandCenterRouter.get('/errors', async (req, res) => {
  const severity = typeof req.query.severity === 'string' ? req.query.severity.toUpperCase() : 'ALL';
  const unresolved = req.query.unresolved !== 'false';
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const where: Prisma.SecurityEventWhereInput = {};
  if (severity !== 'ALL' && ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(severity)) where.severity = severity as never;
  if (unresolved) where.isResolved = false;
  const [items, critical, high, unresolvedCount, quarantined, invalidUploads] = await Promise.all([
    prisma.securityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { user: { select: { discordId: true, username: true } } } }),
    prisma.securityEvent.count({ where: { severity: 'CRITICAL', isResolved: false } }),
    prisma.securityEvent.count({ where: { severity: 'HIGH', isResolved: false } }),
    prisma.securityEvent.count({ where: { isResolved: false } }),
    prisma.package.count({ where: { status: 'QUARANTINED' } }),
    prisma.upload.count({ where: { validationStatus: 'INVALID' } }),
  ]);
  res.json({ items, counts: { critical, high, unresolved: unresolvedCount, quarantined, invalidUploads } });
});

// ---------------------------------------------------------------------------
// ADMIN-AUDIT + ADMIN-LOGS
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/audit', async (req, res) => {
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category.toUpperCase() : '';
  const userDiscordId = typeof req.query.user === 'string' ? req.query.user.trim() : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 7));
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
  const since = new Date(Date.now() - days * 86_400_000);

  let userId: string | undefined;
  if (userDiscordId) userId = (await prisma.user.findUnique({ where: { discordId: userDiscordId }, select: { id: true } }))?.id;

  if (q.length >= 2) {
    const rows = await prisma.$queryRaw<Array<{ id: string; action: string; category: string; createdAt: Date; actorId: string | null; targetId: string | null; details: unknown; isImmutable: boolean }>>`
      SELECT id, action, category, "createdAt", "actorId", "targetId", details, "isImmutable"
      FROM "AuditLog"
      WHERE "createdAt" >= ${since}
        AND (action ILIKE ${'%' + q + '%'} OR details::text ILIKE ${'%' + q + '%'})
      ORDER BY "createdAt" DESC
      LIMIT ${limit}
    `;
    res.json({ items: rows, total: rows.length, fullText: true });
    return;
  }

  const where: Prisma.AuditLogWhereInput = { createdAt: { gte: since } };
  if (action) where.action = { contains: action, mode: 'insensitive' };
  if (category) where.category = category as never;
  if (userId) where.OR = [{ actorId: userId }, { targetId: userId }];
  const items = await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit, include: { actor: { select: { discordId: true, username: true } }, target: { select: { discordId: true, username: true } } } });
  res.json({ items, total: items.length, fullText: false });
});

botAdminCommandCenterRouter.get('/audit/compliance', async (_req, res) => {
  const [usersWithoutConsent, usersWithoutConsentList, pendingDeletions, expiredSessions, expiredOtps, orphanedData] = await Promise.all([
    prisma.user.count({ where: { gdprConsent: null } }),
    prisma.user.findMany({ where: { gdprConsent: null }, select: { username: true, discordId: true, createdAt: true }, orderBy: { createdAt: 'asc' }, take: 50 }),
    prisma.dataDeletionRequest.count({ where: { status: 'PENDING' } }),
    prisma.session.count({ where: { expiresAt: { lt: new Date() }, isActive: true } }),
    prisma.oneTimePassword.count({ where: { expiresAt: { lt: new Date() }, isUsed: false, isRevoked: false } }),
    prisma.upload.count({ where: { isDeleted: true, deletedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }),
  ]);
  res.json({ usersWithoutConsent, usersWithoutConsentList, pendingDeletions, expiredSessions, expiredOtps, orphanedData, ok: usersWithoutConsent + pendingDeletions + expiredSessions + expiredOtps + orphanedData === 0 });
});

botAdminCommandCenterRouter.get('/audit/export', async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: since } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 50_000 });
  audit(req, 'BOTADMIN_AUDIT_EXPORT', 'ADMIN', { days, count: rows.length });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit_export_${days}d_${Date.now()}.json"`);
  res.send(JSON.stringify(toJson(rows), null, 2));
});

// ---------------------------------------------------------------------------
// ADMIN-AIMODELS
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/providers', async (_req, res) => {
  const [stats, order] = await Promise.all([getStats(), getRankedProviders()]);
  res.json({ stats, order, cooldowns: getAllCooldowns(), primary: config.ai.provider, providers: ALL_PROVIDERS });
});

botAdminCommandCenterRouter.post('/providers/probe', async (req, res) => {
  const target = String(req.body?.provider ?? 'all').toLowerCase();
  if (target !== 'all' && !(ALL_PROVIDERS as readonly string[]).includes(target)) { res.status(400).json({ error: 'Unbekannter Provider.' }); return; }
  const targets: ProviderName[] = target === 'all' ? [...ALL_PROVIDERS] : [target as ProviderName];
  const results = await Promise.all(targets.map(async provider => ({ provider, ...(await probeProvider(provider)) })));
  audit(req, 'BOTADMIN_AI_PROVIDER_PROBE', 'AI', { target });
  res.json({ results });
});

botAdminCommandCenterRouter.post('/providers/reset', async (req, res) => {
  const target = String(req.body?.provider ?? '').toLowerCase();
  if (req.body?.confirm !== 'RESET') { res.status(400).json({ error: 'Bestätigung RESET erforderlich.' }); return; }
  if (target !== 'all' && !(ALL_PROVIDERS as readonly string[]).includes(target)) { res.status(400).json({ error: 'Unbekannter Provider.' }); return; }
  if (target === 'all') {
    await prisma.aiProviderStat.deleteMany({});
    ALL_PROVIDERS.forEach(clearCooldown);
  } else {
    await prisma.aiProviderStat.deleteMany({ where: { provider: target } });
    clearCooldown(target as ProviderName);
  }
  audit(req, 'BOTADMIN_AI_PROVIDER_RESET', 'AI', { target });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// AI-TRIGGER (inkl. direktem Browser-Dateiupload)
// ---------------------------------------------------------------------------
function mediaKind(buffer: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | 'mp4' | 'webm' | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  const sig = buffer.length >= 6 ? buffer.subarray(0, 6).toString('ascii') : '';
  if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm';
  if (buffer.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(buffer.subarray(4, 8).toString('ascii'))) return 'mp4';
  return null;
}

async function saveBrowserMedia(file: Express.Multer.File, guildId: string, key: string): Promise<{ ok: true; localPath: string } | { ok: false; error: string }> {
  if (!MEDIA_EXT.test(file.originalname) || !MEDIA_MIME.test(file.mimetype)) return { ok: false, error: 'Nur JPG/PNG/GIF/WEBP/MP4/WEBM/MOV erlaubt.' };
  const kind = mediaKind(file.buffer);
  if (!kind) return { ok: false, error: 'Dateiinhalt ist kein unterstütztes Bild/Video.' };
  const safeGuild = guildId.replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  const safeKey = key.replace(/[^a-z0-9_-]/gi, '').slice(0, 20);
  const dir = path.join(MEDIA_BASE_DIR, 'triggers', safeGuild);
  await fs.mkdir(dir, { recursive: true, mode: 0o750 });
  const localPath = path.join(dir, `${safeKey}_${randomUUID()}.${kind}`);
  await fs.writeFile(localPath, file.buffer, { mode: 0o640 });
  return { ok: true, localPath };
}

function parseTrigger(req: Parameters<typeof requireBotAdmin>[0], media?: string): { ok: true; trigger: AiTrigger; guildId: string } | { ok: false; error: string } {
  const guildId = guildIdFrom(req);
  if (!guildId) return { ok: false, error: 'Gültige guildId erforderlich.' };
  const id = String(req.body?.id ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id) return { ok: false, error: 'Ungültige Trigger-ID.' };
  const triggerType = String(req.body?.triggerType ?? 'keyword') as AiTrigger['triggerType'];
  if (!['keyword', 'regex', 'mention'].includes(triggerType)) return { ok: false, error: 'Ungültiger Trigger-Typ.' };
  const pattern = String(req.body?.pattern ?? '').slice(0, 500);
  if (!pattern) return { ok: false, error: 'Pattern fehlt.' };
  if (triggerType === 'regex') { try { new RegExp(pattern); } catch (e) { return { ok: false, error: `Ungültiger Regex: ${(e as Error).message}` }; } }
  const responseMode = String(req.body?.responseMode ?? 'text') as AiTrigger['responseMode'];
  if (!['text', 'ai'].includes(responseMode)) return { ok: false, error: 'Ungültiger Antwortmodus.' };
  const rawResponse = String(req.body?.response ?? '').slice(0, 2000);
  if (!rawResponse) return { ok: false, error: 'Antwort/AI-Anweisung fehlt.' };
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  const response = guild ? resolveCustomEmotes(rawResponse, guild) : rawResponse;
  const channelId = String(req.body?.channelId ?? '').trim() || undefined;
  if (channelId && !SNOWFLAKE.test(channelId)) return { ok: false, error: 'Ungültige channelId.' };
  const rawCooldown = req.body?.cooldownSeconds;
  const cooldownSeconds = rawCooldown === undefined || rawCooldown === '' ? 10 : Number(rawCooldown);
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0 || cooldownSeconds > 3600) return { ok: false, error: 'Cooldown muss eine ganze Zahl zwischen 0 und 3600 sein.' };
  return { ok: true, guildId, trigger: { id, trigger: pattern, triggerType, responseMode, responseText: responseMode === 'text' ? response : undefined, aiPrompt: responseMode === 'ai' ? response : undefined, mediaUrl: media, channelId, cooldownSeconds, createdAt: new Date().toISOString(), createdBy: actor(req) } };
}

botAdminCommandCenterRouter.get('/triggers', async (req, res) => {
  const guildId = guildIdFrom(req);
  if (!guildId) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  res.json({ items: await listTriggers(guildId), max: MAX_TRIGGERS_PER_GUILD });
});

botAdminCommandCenterRouter.post('/triggers', async (req, res) => {
  const guildId = guildIdFrom(req);
  if (!guildId) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  const id = String(req.body?.id ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id) { res.status(400).json({ error: 'Ungültige Trigger-ID.' }); return; }
  let media: string | undefined;
  const remoteUrl = typeof req.body?.mediaUrl === 'string' ? req.body.mediaUrl.trim() : '';
  if (remoteUrl) {
    const saved = await saveRemoteMedia(remoteUrl, 'triggers', guildId, id);
    if (!saved.ok || !saved.localPath) { res.status(400).json({ error: saved.message }); return; }
    media = saved.localPath;
  }
  const parsed = parseTrigger(req, media);
  if (!parsed.ok) { if (media) await deleteMediaIfLocal(media); res.status(400).json({ error: parsed.error }); return; }
  const result = await addTrigger(guildId, parsed.trigger);
  if (!result.ok) { if (media) await deleteMediaIfLocal(media); res.status(400).json({ error: result.message }); return; }
  audit(req, 'BOTADMIN_AI_TRIGGER_UPSERT', 'AI', { guildId, triggerId: parsed.trigger.id, triggerType: parsed.trigger.triggerType, responseMode: parsed.trigger.responseMode });
  res.status(201).json({ ok: true, message: result.message });
});

botAdminCommandCenterRouter.post('/triggers/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) { res.status(400).json({ error: 'Datei fehlt.' }); return; }
  if (typeof req.body?.mediaUrl === 'string' && req.body.mediaUrl.trim()) { res.status(400).json({ error: 'Bitte entweder Datei ODER mediaUrl angeben, nicht beides.' }); return; }
  const guildId = guildIdFrom(req);
  if (!guildId) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  const id = String(req.body?.id ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
  if (!id) { res.status(400).json({ error: 'Ungültige Trigger-ID.' }); return; }
  const saved = await saveBrowserMedia(file, guildId, id);
  if (!saved.ok) { res.status(400).json({ error: saved.error }); return; }
  const parsed = parseTrigger(req, saved.localPath);
  if (!parsed.ok) { await deleteMediaIfLocal(saved.localPath); res.status(400).json({ error: parsed.error }); return; }
  const result = await addTrigger(guildId, parsed.trigger);
  if (!result.ok) { await deleteMediaIfLocal(saved.localPath); res.status(400).json({ error: result.message }); return; }
  audit(req, 'BOTADMIN_AI_TRIGGER_UPSERT', 'AI', { guildId, triggerId: parsed.trigger.id, mediaUpload: true });
  res.status(201).json({ ok: true, message: result.message });
});

botAdminCommandCenterRouter.delete('/triggers/:id', async (req, res) => {
  const guildId = guildIdFrom(req);
  if (!guildId) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  const id = String(req.params.id);
  const existing = (await listTriggers(guildId)).find(t => t.id === id);
  const result = await removeTrigger(guildId, id, actor(req));
  if (!result.ok) { res.status(404).json({ error: result.message }); return; }
  if (existing?.mediaUrl) await deleteMediaIfLocal(existing.mediaUrl);
  audit(req, 'BOTADMIN_AI_TRIGGER_DELETE', 'AI', { guildId, triggerId: id });
  res.json({ ok: true });
});

botAdminCommandCenterRouter.post('/triggers/clear', async (req, res) => {
  const guildId = guildIdFrom(req);
  if (!guildId) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  if (req.body?.confirm !== 'CLEAR') { res.status(400).json({ error: 'Bestätigung CLEAR erforderlich.' }); return; }
  const all = await listTriggers(guildId);
  const globalIds = new Set(GLOBAL_AI_TRIGGERS.map(t => t.id));
  const guildOwned = all.filter(t => !globalIds.has(t.id));
  await clearTriggers(guildId, actor(req));
  await Promise.all(guildOwned.map(t => deleteMediaIfLocal(t.mediaUrl)));
  audit(req, 'BOTADMIN_AI_TRIGGER_CLEAR', 'AI', { guildId, count: guildOwned.length });
  res.json({ ok: true, cleared: guildOwned.length });
});

// ---------------------------------------------------------------------------
// ADMIN-FEEDBACK: fehlende Channel-Konfiguration + Notify-Refresh
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/feedback-channel', async (req, res) => {
  const guildId = typeof req.query.guildId === 'string' && SNOWFLAKE.test(req.query.guildId) ? req.query.guildId : null;
  const [globalCfg, profile] = await Promise.all([
    prisma.botConfig.findUnique({ where: { key: 'globalFeedbackChannelId' } }),
    guildId ? prisma.guildProfile.findUnique({ where: { guildId }, select: { guildId: true, feedbackChannelId: true } }) : Promise.resolve(null),
  ]);
  res.json({ globalChannelId: typeof globalCfg?.value === 'string' ? globalCfg.value : null, guildChannelId: profile?.feedbackChannelId ?? null });
});

botAdminCommandCenterRouter.put('/feedback-channel', async (req, res) => {
  const scope = req.body?.scope === 'global' ? 'global' : 'guild';
  const channelId = typeof req.body?.channelId === 'string' && req.body.channelId.trim() ? req.body.channelId.trim() : null;
  if (channelId && !SNOWFLAKE.test(channelId)) { res.status(400).json({ error: 'Ungültige channelId.' }); return; }
  if (scope === 'global') {
    await prisma.botConfig.upsert({
      where: { key: 'globalFeedbackChannelId' },
      create: { key: 'globalFeedbackChannelId', value: channelId ?? Prisma.JsonNull, category: 'feedback', description: 'Owner-Fallback-Channel für /feedback.', updatedBy: actor(req) },
      update: { value: channelId ?? Prisma.JsonNull, updatedBy: actor(req) },
    });
    audit(req, 'FEEDBACK_GLOBAL_CHANNEL_SET', 'ADMIN', { channelId });
    res.json({ ok: true }); return;
  }
  const guildId = String(req.body?.guildId ?? '');
  if (!SNOWFLAKE.test(guildId)) { res.status(400).json({ error: 'Gültige guildId erforderlich.' }); return; }
  const client = tryGetDashboardClient();
  await prisma.guildProfile.upsert({ where: { guildId }, create: { guildId, name: client?.guilds.cache.get(guildId)?.name ?? 'unknown', feedbackChannelId: channelId }, update: { feedbackChannelId: channelId } });
  audit(req, 'FEEDBACK_CHANNEL_SET', 'ADMIN', { guildId, channelId });
  res.json({ ok: true });
});

botAdminCommandCenterRouter.patch('/feedback/:id', async (req, res) => {
  const fb = await prisma.feedback.findUnique({ where: { id: String(req.params.id) } });
  if (!fb) { res.status(404).json({ error: 'Feedback nicht gefunden.' }); return; }
  const status = req.body?.status === undefined ? fb.status : String(req.body.status).toUpperCase();
  if (!['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX'].includes(status)) { res.status(400).json({ error: 'Ungültiger Status.' }); return; }
  const adminNote = req.body?.adminNote === undefined ? fb.adminNote : String(req.body.adminNote).slice(0, 2000);
  const updated = await prisma.feedback.update({ where: { id: fb.id }, data: { status: status as never, adminNote, reviewedBy: actor(req), reviewedAt: new Date() } });
  if (updated.notifyChannelId && updated.notifyMessageId) {
    const client = tryGetDashboardClient();
    try {
      const ch = await client?.channels.fetch(updated.notifyChannelId).catch(() => null);
      if (ch?.isTextBased()) {
        const msg = await (ch as TextChannel).messages.fetch(updated.notifyMessageId).catch(() => null);
        if (msg) {
          const embed = new EmbedBuilder().setTitle(`${updated.category} • ${updated.subject}`).setDescription(updated.message.slice(0, 3500)).addFields(
            { name: 'Von', value: `<@${updated.userId}> (\`${updated.userId}\`)`, inline: true },
            { name: 'Status', value: `\`${updated.status}\``, inline: true },
            { name: 'ID', value: `\`${updated.id}\`` },
          );
          if (updated.adminNote) embed.addFields({ name: 'Admin-Notiz', value: updated.adminNote.slice(0, 1024) });
          await msg.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      }
    } catch (e) { logger.warn('BotAdmin Feedback Notify-Refresh fehlgeschlagen', { err: (e as Error).message }); }
  }
  audit(req, 'BOTADMIN_FEEDBACK_UPDATE', 'ADMIN', { feedbackId: fb.id, status, noteChanged: adminNote !== fb.adminNote });
  res.json(updated);
});

// ---------------------------------------------------------------------------
// ADMIN-VALIDATE + ADMIN-DELETE fehlende Paritaet
// ---------------------------------------------------------------------------
async function validateUpload(uploadId: string, validatedBy: string) {
  const file = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!file) throw Object.assign(new Error('Upload nicht gefunden.'), { status: 404 });
  if (!isInsideUploadRoot(file.filePath)) throw Object.assign(new Error('Dateipfad ausserhalb Upload-Root.'), { status: 400 });
  const stat = await fs.stat(file.filePath).catch(() => null);
  if (!stat) throw Object.assign(new Error('Datei auf dem Server nicht gefunden.'), { status: 404 });
  if (stat.size > MAX_VALIDATE_BYTES) throw Object.assign(new Error('Datei zu groß (>50 MB).'), { status: 413 });
  const validation = await withTimeout(validateFile(file.filePath), VALIDATE_TIMEOUT_MS, `dashboardValidate:${uploadId}`);
  if (!validation) throw Object.assign(new Error('Validierung Timeout.'), { status: 504 });
  await prisma.$transaction([
    prisma.upload.update({ where: { id: file.id }, data: { isValid: validation.isValid, validationStatus: validation.isValid ? 'VALID' : 'INVALID' } }),
    prisma.validationResult.create({ data: { uploadId: file.id, packageId: file.packageId, isValid: validation.isValid, errors: JSON.parse(JSON.stringify(validation.errors)), warnings: JSON.parse(JSON.stringify(validation.warnings)), suggestions: JSON.parse(JSON.stringify(validation.suggestions)), validatedBy } }),
  ]);
  return { id: file.id, name: file.originalName, isValid: validation.isValid, errors: validation.errors, warnings: validation.warnings, suggestions: validation.suggestions };
}

botAdminCommandCenterRouter.post('/validate/package/:id', async (req, res) => {
  const pkg = await prisma.package.findUnique({ where: { id: String(req.params.id) }, include: { files: { select: { id: true } } } });
  if (!pkg) { res.status(404).json({ error: 'Paket nicht gefunden.' }); return; }
  const results = [];
  for (const f of pkg.files) {
    try { results.push({ ok: true, ...(await validateUpload(f.id, actor(req))) }); }
    catch (e) { results.push({ ok: false, id: f.id, error: (e as Error).message }); }
  }
  audit(req, 'BOTADMIN_PACKAGE_REVALIDATED', 'ADMIN', { packageId: pkg.id, files: results.length, invalid: results.filter(r => !r.ok || ('isValid' in r && !r.isValid)).length });
  res.json({ packageId: pkg.id, results });
});

botAdminCommandCenterRouter.post('/validate/upload/:id', async (req, res) => {
  try {
    const result = await validateUpload(String(req.params.id), actor(req));
    audit(req, 'BOTADMIN_FILE_REVALIDATED', 'ADMIN', { uploadId: result.id, isValid: result.isValid });
    res.json(result);
  } catch (e) { res.status(Number((e as { status?: number }).status) || 500).json({ error: (e as Error).message }); }
});

botAdminCommandCenterRouter.delete('/uploads/:id', async (req, res) => {
  const file = await prisma.upload.findUnique({ where: { id: String(req.params.id) } });
  if (!file || file.isDeleted) { res.status(404).json({ error: 'Datei nicht gefunden oder bereits gelöscht.' }); return; }
  await prisma.$transaction([
    prisma.upload.update({ where: { id: file.id }, data: { isDeleted: true, deletedAt: new Date() } }),
    prisma.package.update({ where: { id: file.packageId }, data: { fileCount: { decrement: 1 }, totalSize: { decrement: file.fileSize } } }),
  ]);
  if (isInsideUploadRoot(file.filePath)) await fs.unlink(file.filePath).catch(() => undefined);
  audit(req, 'BOTADMIN_FILE_DELETE', 'ADMIN', { uploadId: file.id, packageId: file.packageId });
  res.json({ deleted: true });
});

async function hardDeletePackage(id: string): Promise<{ filesRemoved: number }> {
  const pkg = await prisma.package.findUnique({ where: { id }, include: { files: { select: { filePath: true } } } });
  if (!pkg) throw Object.assign(new Error('Paket nicht gefunden.'), { status: 404 });
  let filesRemoved = 0;
  for (const f of pkg.files) {
    if (!isInsideUploadRoot(f.filePath)) { logger.error(`BotAdmin hard-delete blockiert Pfad ausserhalb Upload-Root: ${f.filePath}`); continue; }
    try { await fs.unlink(f.filePath); filesRemoved++; } catch { /* already gone */ }
  }
  await prisma.package.delete({ where: { id } });
  return { filesRemoved };
}

botAdminCommandCenterRouter.delete('/packages/:id/hard', async (req, res) => {
  if (req.body?.confirm !== 'DELETE') { res.status(400).json({ error: 'Bestätigung DELETE erforderlich.' }); return; }
  try {
    const r = await hardDeletePackage(String(req.params.id));
    audit(req, 'BOTADMIN_PACKAGE_HARD_DELETE', 'ADMIN', { packageId: String(req.params.id), ...r });
    res.json({ deleted: true, ...r });
  } catch (e) { res.status(Number((e as { status?: number }).status) || 500).json({ error: (e as Error).message }); }
});

botAdminCommandCenterRouter.post('/users/:id/packages/delete', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!user) { res.status(404).json({ error: 'Nutzer nicht gefunden.' }); return; }
  const hard = req.body?.hard === true;
  if (hard && req.body?.confirm !== 'DELETE') { res.status(400).json({ error: 'Bestätigung DELETE erforderlich.' }); return; }
  const pkgs = await prisma.package.findMany({ where: { userId: user.id }, select: { id: true } });
  let filesRemoved = 0;
  if (hard) {
    for (const p of pkgs) filesRemoved += (await hardDeletePackage(p.id)).filesRemoved;
  } else {
    await prisma.package.updateMany({ where: { userId: user.id, isDeleted: false }, data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor(req), status: 'DELETED' } });
    await prisma.upload.updateMany({ where: { userId: user.id, isDeleted: false }, data: { isDeleted: true, deletedAt: new Date() } });
  }
  audit(req, hard ? 'BOTADMIN_BULK_HARD_DELETE' : 'BOTADMIN_BULK_SOFT_DELETE', 'ADMIN', { userId: user.id, packages: pkgs.length, filesRemoved });
  res.json({ deletedPackages: pkgs.length, filesRemoved, hard });
});
