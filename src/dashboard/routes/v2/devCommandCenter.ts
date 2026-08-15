import { Router } from 'express';
import os from 'node:os';
import { isIP } from 'node:net';
import { Prisma } from '@prisma/client';
import { requireDev } from '../../middleware/auth';
import { validateStepUpInput, logDevAction } from '../../middleware/devSecurity';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { loadCommands, deployCommandsScoped } from '../../../commands/handler';
import { config } from '../../../config';
import { logger } from '../../../utils/logger';

/**
 * Dashboard-Paritaet fuer alle devOnly Slash-Commands (ausser explizit
 * beibehaltene Hersteller-Funktionen). Alle Endpunkte sind requireDev-geschuetzt
 * (Developer-Identitaet + aktive DevSession + MFA/IP-Gates im zentralen Stack).
 */
export const devCommandCenterRouter = Router();
devCommandCenterRouter.use(requireDev);

const SNOWFLAKE = /^\d{17,20}$/;
const ALLOWED_CONFIG_KEYS = new Set([
  'upload.maxSize', 'upload.allowedExtensions', 'rateLimit.windowMs', 'rateLimit.maxRequests',
  'moderation.autoModEnabled', 'moderation.spamThreshold', 'moderation.raidThreshold',
  'welcome.enabled', 'welcome.message', 'leveling.enabled', 'leveling.xpPerMessage',
  'leveling.cooldownSeconds', 'ai.enabled', 'ai.maxTokens', 'feeds.pollIntervalMinutes',
]);
const PROTECTED_PREFIXES = ['bot:', 'system.', 'singleton'];
const MAX_CONFIG_VALUE_LEN = 4096;

function actor(req: Parameters<typeof requireDev>[0]): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'developer');
}

function requireStepUp(req: Parameters<typeof requireDev>[0], res: Parameters<typeof requireDev>[1]): boolean {
  const r = validateStepUpInput({ reason: String(req.body?.reason ?? ''), reAuth: String(req.body?.reAuth ?? '') });
  if (!r.ok) { res.status(400).json({ error: r.error ?? 'step_up_invalid' }); return false; }
  return true;
}

function safeConfigValue(key: string, value: unknown): unknown {
  return /password|secret|token|api[_.-]?key|rcon|credential|private/i.test(key) ? '«redigiert»' : value;
}

function toJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? x.toString() : x));
}

// ---------------------------------------------------------------------------
// /ping + /status + /dev-eval
// ---------------------------------------------------------------------------
devCommandCenterRouter.get('/diagnostics', async (_req, res) => {
  const client = tryGetDashboardClient();
  const mem = process.memoryUsage();
  const t = Date.now();
  let dbOk = true;
  try { await prisma.$queryRaw`SELECT 1`; } catch { dbOk = false; }
  const [users, packages, uploads] = await Promise.all([prisma.user.count(), prisma.package.count(), prisma.upload.count()]);
  res.json({
    bot: {
      ready: !!client,
      websocketPingMs: client?.ws.ping ?? -1,
      uptimeMs: client?.uptime ?? Math.round(process.uptime() * 1000),
      guilds: client?.guilds.cache.size ?? 0,
      cachedUsers: client?.users.cache.size ?? 0,
      cachedChannels: client?.channels.cache.size ?? 0,
    },
    database: { ok: dbOk, latencyMs: Date.now() - t, users, packages, uploads },
    system: {
      os: `${os.type()} ${os.release()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length,
      totalMem: os.totalmem(), freeMem: os.freemem(), loadAvg: os.loadavg(), node: process.version,
    },
    process: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external, arrayBuffers: mem.arrayBuffers },
    generatedAt: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// /dev-admin
// ---------------------------------------------------------------------------
devCommandCenterRouter.get('/admins', async (_req, res) => {
  const items = await prisma.user.findMany({
    where: { role: { in: ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'] } },
    orderBy: [{ role: 'asc' }, { username: 'asc' }],
    select: { id: true, discordId: true, username: true, role: true, createdAt: true },
  });
  res.json({ items });
});

devCommandCenterRouter.post('/admins', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const discordId = String(req.body?.discordId ?? '').trim();
  if (!SNOWFLAKE.test(discordId)) { res.status(400).json({ error: 'Ungültige Discord-ID.' }); return; }
  const client = tryGetDashboardClient();
  const dUser = await client?.users.fetch(discordId).catch(() => null);
  let user = await prisma.user.findUnique({ where: { discordId } });
  if (user && ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(user.role)) { res.status(409).json({ error: `User ist bereits ${user.role}.` }); return; }
  if (!user) {
    user = await prisma.user.create({ data: { discordId, username: dUser?.username ?? discordId, discriminator: dUser?.discriminator || '0', role: 'ADMIN' } });
  } else {
    user = await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  }
  logDevAction('ADMIN_ROLE_ASSIGNED', req, { targetDiscordId: discordId, targetUserId: user.id, reason: String(req.body.reason) });
  res.status(201).json({ id: user.id, discordId: user.discordId, username: user.username, role: user.role });
});

devCommandCenterRouter.delete('/admins/:discordId', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const discordId = String(req.params.discordId);
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user || user.role !== 'ADMIN') {
    res.status(user && ['SUPER_ADMIN', 'DEVELOPER'].includes(user.role) ? 409 : 404).json({ error: user ? `Rolle ${user.role} darf hier nicht entfernt werden.` : 'Admin nicht gefunden.' });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } });
  logDevAction('ADMIN_ROLE_REMOVED', req, { targetDiscordId: discordId, targetUserId: user.id, reason: String(req.body.reason) });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// /dev-db
// ---------------------------------------------------------------------------
devCommandCenterRouter.get('/database', async (_req, res) => {
  const [users, packages, uploads, auditLogs, sessions, giveaways, otps] = await Promise.all([
    prisma.user.count(), prisma.package.count(), prisma.upload.count(), prisma.auditLog.count(),
    prisma.session.count(), prisma.giveaway.count(), prisma.oneTimePassword.count(),
  ]);
  res.json({ users, packages, uploads, auditLogs, sessions, giveaways, otps });
});

devCommandCenterRouter.get('/database/users', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.status(400).json({ error: 'q fehlt.' }); return; }
  const items = await prisma.user.findMany({
    where: { OR: [{ username: { contains: q, mode: 'insensitive' } }, { discordId: { contains: q } }, { email: { contains: q, mode: 'insensitive' } }] },
    take: 25,
    select: { id: true, discordId: true, username: true, role: true, isManufacturer: true, createdAt: true },
  });
  res.json({ items });
});

devCommandCenterRouter.get('/database/packages', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) { res.status(400).json({ error: 'q fehlt.' }); return; }
  const items = await prisma.package.findMany({
    where: { name: { contains: q, mode: 'insensitive' } }, take: 25,
    include: { user: { select: { username: true, discordId: true } }, _count: { select: { files: true } } },
  });
  res.json({ items: toJson(items) });
});

devCommandCenterRouter.post('/database/cleanup', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const now = new Date();
  const [sessions, otps] = await prisma.$transaction([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.oneTimePassword.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { isUsed: true }, { isRevoked: true }] } }),
  ]);
  logDevAction('DEV_DB_CLEANUP', req, { sessions: sessions.count, otps: otps.count, reason: String(req.body.reason) });
  res.json({ sessionsDeleted: sessions.count, otpsDeleted: otps.count });
});

// ---------------------------------------------------------------------------
// /admin-config (devOnly)
// ---------------------------------------------------------------------------
devCommandCenterRouter.get('/config', async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  const items = await prisma.botConfig.findMany({ where: category ? { category } : {}, orderBy: [{ category: 'asc' }, { key: 'asc' }] });
  res.json({ allowedKeys: [...ALLOWED_CONFIG_KEYS], items: items.map(x => ({ ...x, value: safeConfigValue(x.key, x.value) })) });
});

devCommandCenterRouter.put('/config/:key', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const key = decodeURIComponent(String(req.params.key));
  if (PROTECTED_PREFIXES.some(p => key.toLowerCase().startsWith(p)) || !ALLOWED_CONFIG_KEYS.has(key)) { res.status(403).json({ error: 'Schlüssel ist geschützt oder nicht freigegeben.' }); return; }
  const raw = typeof req.body?.value === 'string' ? req.body.value : JSON.stringify(req.body?.value);
  if (!raw || raw.length > MAX_CONFIG_VALUE_LEN) { res.status(400).json({ error: `Wert muss 1..${MAX_CONFIG_VALUE_LEN} Zeichen haben.` }); return; }
  let value: Prisma.InputJsonValue;
  try { value = JSON.parse(raw) as Prisma.InputJsonValue; } catch { value = raw; }
  const category = key.split('.')[0] || 'general';
  const description = typeof req.body?.description === 'string' ? req.body.description.slice(0, 500) : undefined;
  const row = await prisma.botConfig.upsert({
    where: { key }, create: { key, value, category, description, updatedBy: actor(req) },
    update: { value, description, updatedBy: actor(req) },
  });
  logDevAction('CONFIG_UPDATED', req, { key, value: safeConfigValue(key, raw), reason: String(req.body.reason) });
  res.json({ ...row, value: safeConfigValue(row.key, row.value) });
});

devCommandCenterRouter.delete('/config/:key', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const key = decodeURIComponent(String(req.params.key));
  if (PROTECTED_PREFIXES.some(p => key.toLowerCase().startsWith(p)) || !ALLOWED_CONFIG_KEYS.has(key)) { res.status(403).json({ error: 'Schlüssel ist geschützt oder nicht freigegeben.' }); return; }
  const existing = await prisma.botConfig.findUnique({ where: { key } });
  if (!existing) { res.status(404).json({ error: 'Konfiguration nicht gefunden.' }); return; }
  if (existing.category === 'system') { res.status(403).json({ error: 'System-Konfiguration ist geschützt.' }); return; }
  await prisma.botConfig.delete({ where: { key } });
  logDevAction('CONFIG_DELETED', req, { key, reason: String(req.body.reason) });
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// /admin-security (devOnly)
// ---------------------------------------------------------------------------
devCommandCenterRouter.get('/security', async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type.toUpperCase() : 'ALL';
  const where: Prisma.SecurityEventWhereInput = type !== 'ALL' ? { eventType: type as never } : {};
  const [events, ipList] = await Promise.all([
    prisma.securityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { user: { select: { discordId: true, username: true } } } }),
    prisma.ipList.findMany({ orderBy: [{ listType: 'asc' }, { createdAt: 'desc' }] }),
  ]);
  res.json({ events, ipList });
});

devCommandCenterRouter.put('/security/ip/:ip', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const ip = decodeURIComponent(String(req.params.ip)).trim();
  if (isIP(ip) === 0) { res.status(400).json({ error: 'Ungültige IPv4/IPv6-Adresse.' }); return; }
  const listType = String(req.body?.listType ?? '').toUpperCase();
  if (!['BLACKLIST', 'WHITELIST'].includes(listType)) { res.status(400).json({ error: 'listType muss BLACKLIST oder WHITELIST sein.' }); return; }
  const reasonText = String(req.body?.listReason ?? req.body?.reasonText ?? '').trim();
  if (!reasonText) { res.status(400).json({ error: 'Begründung fehlt.' }); return; }
  const hours = Math.min(8760, Math.max(0, Number(req.body?.durationHours) || 0));
  const expiresAt = hours > 0 ? new Date(Date.now() + hours * 3_600_000) : null;
  const row = await prisma.ipList.upsert({
    where: { ipAddress: ip },
    create: { ipAddress: ip, listType: listType as never, reason: reasonText, addedBy: actor(req), expiresAt },
    update: { listType: listType as never, reason: reasonText, addedBy: actor(req), expiresAt },
  });
  logDevAction(listType === 'BLACKLIST' ? 'IP_BLACKLISTED' : 'IP_WHITELISTED', req, { ip, listType, hours, reason: String(req.body.reason) });
  res.json(row);
});

devCommandCenterRouter.delete('/security/ip/:ip', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const ip = decodeURIComponent(String(req.params.ip)).trim();
  if (isIP(ip) === 0) { res.status(400).json({ error: 'Ungültige IP.' }); return; }
  const row = await prisma.ipList.findUnique({ where: { ipAddress: ip } });
  if (!row) { res.status(404).json({ error: 'IP nicht gelistet.' }); return; }
  await prisma.ipList.delete({ where: { ipAddress: ip } });
  logDevAction('IP_REMOVED_FROM_LIST', req, { ip, listType: row.listType, reason: String(req.body.reason) });
  res.json({ deleted: true });
});

devCommandCenterRouter.post('/security/events/:id/resolve', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const event = await prisma.securityEvent.findUnique({ where: { id: String(req.params.id) } });
  if (!event) { res.status(404).json({ error: 'Security-Event nicht gefunden.' }); return; }
  if (!event.isResolved) await prisma.securityEvent.update({ where: { id: event.id }, data: { isResolved: true, resolvedBy: actor(req), resolvedAt: new Date() } });
  logDevAction('SECURITY_EVENT_RESOLVED', req, { eventId: event.id, reason: String(req.body.reason) });
  res.json({ ok: true, alreadyResolved: event.isResolved });
});

// ---------------------------------------------------------------------------
// /admin-export (devOnly) - Browserdownloads statt Discord-Attachments
// ---------------------------------------------------------------------------
async function findUserByDiscord(discordId: string) {
  return prisma.user.findUnique({ where: { discordId } });
}

function sendJsonAttachment(res: Parameters<typeof requireDev>[1], filename: string, payload: unknown): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^a-z0-9_.-]/gi, '_')}"`);
  res.send(JSON.stringify(toJson(payload), null, 2));
}

devCommandCenterRouter.get('/export/packages/:discordId', async (req, res) => {
  const discordId = String(req.params.discordId);
  const user = await findUserByDiscord(discordId);
  if (!user) { res.status(404).json({ error: 'User nicht in der Datenbank.' }); return; }
  const packages = await prisma.package.findMany({ where: { userId: user.id }, include: { files: true } });
  logDevAction('DATA_EXPORT', req, { type: 'packages', targetUserId: user.id, targetDiscordId: discordId });
  sendJsonAttachment(res, `pakete_${user.username}_${Date.now()}.json`, packages);
});

devCommandCenterRouter.get('/export/logs', async (req, res) => {
  const category = typeof req.query.category === 'string' ? req.query.category.toUpperCase() : 'ALL';
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const where: Prisma.AuditLogWhereInput = { createdAt: { gte: since } };
  if (category !== 'ALL') where.category = category as never;
  // Hard cap als HTTP-Export-Schutz. Cursor/Pagination verhindert Query-Explosion,
  // die Antwort wird nach Aufbau einmalig gesendet; 50k entspricht alter Slash-Paritaet.
  const all = [];
  let cursor: string | undefined;
  while (all.length < 50_000) {
    const page = await prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: Math.min(1000, 50_000 - all.length), ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}) });
    if (!page.length) break;
    all.push(...page);
    cursor = page[page.length - 1].id;
    if (page.length < 1000) break;
  }
  logDevAction('LOG_EXPORT', req, { category, days, count: all.length });
  sendJsonAttachment(res, `audit_logs_${category}_${days}d_${Date.now()}.json`, all);
});

devCommandCenterRouter.get('/export/user/:discordId', async (req, res) => {
  const discordId = String(req.params.discordId);
  const user = await prisma.user.findUnique({
    where: { discordId },
    include: { packages: true, uploads: true, downloads: true, moderationCases: true, appeals: true, levelData: true, xpRecords: true, giveawayEntries: true, pollVotes: true, gdprConsent: true },
  });
  if (!user) { res.status(404).json({ error: 'User nicht in der Datenbank.' }); return; }
  logDevAction('GDPR_DATA_EXPORT', req, { targetUserId: user.id, targetDiscordId: discordId });
  sendJsonAttachment(res, `nutzerdaten_${user.username}_${Date.now()}.json`, user);
});

// ---------------------------------------------------------------------------
// /xp-config (devOnly) - strikt pro Guild, vollstaendige Paritaet
// ---------------------------------------------------------------------------
async function xpConfig(guildId: string) {
  return prisma.xpConfig.upsert({ where: { id: guildId }, update: {}, create: { id: guildId } });
}

devCommandCenterRouter.get('/xp/:guildId', async (req, res) => {
  const guildId = String(req.params.guildId);
  if (!SNOWFLAKE.test(guildId)) { res.status(400).json({ error: 'Ungültige guildId.' }); return; }
  const [cfg, levelRoles] = await Promise.all([xpConfig(guildId), prisma.levelRole.findMany({ where: { guildId }, orderBy: { level: 'asc' } })]);
  const client = tryGetDashboardClient();
  const guild = client?.guilds.cache.get(guildId);
  const roleOptions = guild ? [...guild.roles.cache.values()].filter(r => !r.managed && r.id !== guild.id).map(r => ({ id: r.id, name: r.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const channelOptions = guild ? [...guild.channels.cache.values()].filter(c => c.isTextBased()).map(c => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) : [];
  res.json({ config: cfg, levelRoles, roleOptions, channelOptions });
});

devCommandCenterRouter.patch('/xp/:guildId', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const guildId = String(req.params.guildId);
  if (!SNOWFLAKE.test(guildId)) { res.status(400).json({ error: 'Ungültige guildId.' }); return; }
  const current = await xpConfig(guildId);
  const data: Record<string, unknown> = {};
  const intField = (name: string, min: number, max: number) => {
    if (req.body?.[name] === undefined) return true;
    const v = Number(req.body[name]);
    if (!Number.isInteger(v) || v < min || v > max) return false;
    data[name] = v; return true;
  };
  if (!intField('messageXpMin', 0, 10000) || !intField('messageXpMax', 0, 10000) || !intField('voiceXpPerMinute', 0, 10000) || !intField('maxLevel', 1, 100)) {
    res.status(400).json({ error: 'Ungültiger XP-Zahlenwert.' }); return;
  }
  if (req.body?.levelMultiplier !== undefined) {
    const v = Number(req.body.levelMultiplier); if (!Number.isFinite(v) || v < 0 || v > 100) { res.status(400).json({ error: 'levelMultiplier 0..100.' }); return; } data.levelMultiplier = v;
  }
  const effMin = Number(data.messageXpMin ?? current.messageXpMin);
  const effMax = Number(data.messageXpMax ?? current.messageXpMax);
  if (effMin > effMax) { res.status(400).json({ error: 'Min-XP darf nicht größer als Max-XP sein.' }); return; }
  if (req.body?.maxLevelRoleId !== undefined) {
    const v = req.body.maxLevelRoleId; if (v !== null && !SNOWFLAKE.test(String(v))) { res.status(400).json({ error: 'Ungültige maxLevelRoleId.' }); return; } data.maxLevelRoleId = v === null ? null : String(v);
  }
  if (req.body?.allowedRoleIds !== undefined) {
    if (!Array.isArray(req.body.allowedRoleIds) || !req.body.allowedRoleIds.every((x: unknown) => typeof x === 'string' && SNOWFLAKE.test(x))) { res.status(400).json({ error: 'allowedRoleIds ungültig.' }); return; }
    data.allowedRoleIds = [...new Set(req.body.allowedRoleIds as string[])];
  }
  if (req.body?.allowedChannelIds !== undefined) {
    if (!Array.isArray(req.body.allowedChannelIds) || !req.body.allowedChannelIds.every((x: unknown) => typeof x === 'string' && SNOWFLAKE.test(x))) { res.status(400).json({ error: 'allowedChannelIds ungültig.' }); return; }
    data.allowedChannelIds = [...new Set(req.body.allowedChannelIds as string[])];
  }
  const updated = await prisma.xpConfig.update({ where: { id: guildId }, data });
  logDevAction('DEV_XP_CONFIG_UPDATE', req, { guildId, fields: Object.keys(data), reason: String(req.body.reason) });
  res.json(updated);
});

devCommandCenterRouter.put('/xp/:guildId/level-role/:level', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const guildId = String(req.params.guildId);
  const level = Number(req.params.level);
  const roleId = String(req.body?.roleId ?? '');
  if (!SNOWFLAKE.test(guildId) || !Number.isInteger(level) || level < 1 || level > 1000 || !SNOWFLAKE.test(roleId)) { res.status(400).json({ error: 'Ungültige Guild/Level/Rolle.' }); return; }
  const row = await prisma.levelRole.upsert({ where: { guildId_level: { guildId, level } }, update: { roleId }, create: { guildId, level, roleId } });
  logDevAction('DEV_XP_LEVELROLE_SET', req, { guildId, level, roleId, reason: String(req.body.reason) });
  res.json(row);
});

devCommandCenterRouter.delete('/xp/:guildId/level-role/:level', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const guildId = String(req.params.guildId); const level = Number(req.params.level);
  if (!SNOWFLAKE.test(guildId) || !Number.isInteger(level)) { res.status(400).json({ error: 'Ungültige Guild/Level.' }); return; }
  const r = await prisma.levelRole.deleteMany({ where: { guildId, level } });
  logDevAction('DEV_XP_LEVELROLE_REMOVE', req, { guildId, level, count: r.count, reason: String(req.body.reason) });
  res.json({ deleted: r.count });
});

// ---------------------------------------------------------------------------
// /dev-reload - Dashboard-only Command Registry Deployment
// ---------------------------------------------------------------------------
devCommandCenterRouter.post('/commands/reload', async (req, res) => {
  if (!requireStepUp(req, res)) return;
  const scope = req.body?.scope === 'deploy' ? 'deploy' : 'all';
  const client = tryGetDashboardClient();
  if (!client) { res.status(503).json({ error: 'Discord-Client nicht verfügbar.' }); return; }
  const oldCount = client.commands.size;
  if (scope === 'all') await loadCommands(client);
  const guildIds = [...client.guilds.cache.keys()];
  const result = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);
  logDevAction('DEV_COMMAND_RELOAD', req, { scope, oldCount, newCount: client.commands.size, ...result, reason: String(req.body.reason) });
  res.json({ oldCount, newCount: client.commands.size, ...result });
});
