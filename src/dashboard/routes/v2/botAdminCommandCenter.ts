/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: intentional cross-tenant system/admin surface (authZ outside Prisma where). */
import { Router } from 'express';
import os from 'node:os';
import fs from 'node:fs/promises';
import { ChannelType, EmbedBuilder, type TextChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import { requireBotAdmin } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logger, logAudit, logAuditDb } from '../../../utils/logger';
import { tryGetDashboardClient } from '../../clientRegistry';
import { config } from '../../../config';
import {
  ALL_PROVIDERS,
  type ProviderName,
  getStats,
  getRankedProviders,
  probeProvider,
  getAllCooldowns,
  clearCooldown,
} from '../../../modules/ai/providerStats';

/**
 * Bot-Admin Command-Center fuer System/Fehler, Audit-Suche/Compliance,
 * AI-Provider und Feedback.
 *
 * Grosse Audit-Downloads, AI-Trigger sowie Datei-/Delete-Operationen liegen
 * bewusst in eigenen kanonischen Routern. Dadurch existiert fuer diese
 * sicherheitskritischen Funktionen nur eine aktive Implementierung.
 */
export const botAdminCommandCenterRouter = Router();
botAdminCommandCenterRouter.use(requireBotAdmin);

const SNOWFLAKE = /^\d{17,20}$/;

function actor(req: Parameters<typeof requireBotAdmin>[0]): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'dashboard');
}

function isBotOwnerRequest(req: Parameters<typeof requireBotAdmin>[0]): boolean {
  return Boolean(config.discord.ownerId) && String(req.auth?.discordId ?? '') === config.discord.ownerId;
}

async function feedbackChannelValidationError(
  channelId: string,
  guildId?: string,
): Promise<{ status: number; error: string } | null> {
  const client = tryGetDashboardClient();
  if (!client) return { status: 503, error: 'Discord-Client nicht verfügbar.' };
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
    return { status: 400, error: 'Feedback-Channel muss ein erreichbarer Text- oder Ankündigungskanal sein.' };
  }
  if (guildId && channel.guildId !== guildId) {
    return { status: 400, error: 'Feedback-Channel gehört nicht zum ausgewählten Server.' };
  }
  return null;
}

function audit(
  req: Parameters<typeof requireBotAdmin>[0],
  action: string,
  category: string,
  details: Record<string, unknown>,
): void {
  const by = actor(req);
  logAudit(action, category as never, { ...details, by });
  logAuditDb(action, category as never, {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
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

  // Paritaet zum bisherigen /admin-monitor: Der Health-Read prueft nur
  // Existenz/Schreibbarkeit. Ein rekursiver Vollscan des Upload-Baums wuerde
  // die Laufzeit mit dem Datenbestand skalieren und gehoert nicht in diesen
  // regelmaessig abgefragten Status-Endpunkt.
  const uploadDir = { exists: false, writable: false };
  try {
    await fs.access(config.upload.dir);
    uploadDir.exists = true;
    try { await fs.access(config.upload.dir, 2); uploadDir.writable = true; } catch { /* read-only */ }
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
    bot: {
      ready: !!client,
      pingMs: client?.ws.ping ?? -1,
      guilds: client?.guilds.cache.size ?? 0,
      users: client ? client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0) : 0,
      uptimeSec: Math.round(process.uptime()),
    },
    database: { ok: dbOk, latencyMs: dbLatencyMs },
    system: {
      load, cpuCount, totalMem, freeMem, usedMemPercent,
      heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, rss: mem.rss,
      node: process.version, os: `${os.type()} ${os.release()}`,
    },
    storage: uploadDir,
    usage: {
      totalUsers, manufacturers, totalPackages, activePackages, quarantinedPackages,
      totalUploads, invalidUploads, totalDownloads, totalCases, activeCases,
      pendingAppeals, activeGiveaways, totalPolls, activePolls, activeFeeds,
      activeSessions, securityEvents, unresolvedSecEvents, unresolvedHigh,
    },
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
    prisma.securityEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { discordId: true, username: true } } },
    }),
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
  if (userDiscordId) {
    userId = (await prisma.user.findUnique({ where: { discordId: userDiscordId }, select: { id: true } }))?.id;
  }

  if (q.length >= 2) {
    const rows = await prisma.$queryRaw<Array<{
      id: string;
      action: string;
      category: string;
      createdAt: Date;
      actorId: string | null;
      targetId: string | null;
      details: unknown;
      isImmutable: boolean;
    }>>`
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
  const items = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { discordId: true, username: true } },
      target: { select: { discordId: true, username: true } },
    },
  });
  res.json({ items, total: items.length, fullText: false });
});

botAdminCommandCenterRouter.get('/audit/compliance', async (_req, res) => {
  const [
    usersWithoutConsent, usersWithoutConsentList, pendingDeletions,
    expiredSessions, expiredOtps, orphanedData,
  ] = await Promise.all([
    prisma.user.count({ where: { gdprConsent: null } }),
    prisma.user.findMany({
      where: { gdprConsent: null },
      select: { username: true, discordId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      take: 50,
    }),
    prisma.dataDeletionRequest.count({ where: { status: 'PENDING' } }),
    prisma.session.count({ where: { expiresAt: { lt: new Date() }, isActive: true } }),
    prisma.oneTimePassword.count({ where: { expiresAt: { lt: new Date() }, isUsed: false, isRevoked: false } }),
    prisma.upload.count({ where: { isDeleted: true, deletedAt: { lt: new Date(Date.now() - 90 * 86_400_000) } } }),
  ]);
  res.json({
    usersWithoutConsent,
    usersWithoutConsentList,
    pendingDeletions,
    expiredSessions,
    expiredOtps,
    orphanedData,
    ok: usersWithoutConsent + pendingDeletions + expiredSessions + expiredOtps + orphanedData === 0,
  });
});

// ---------------------------------------------------------------------------
// ADMIN-AIMODELS
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/providers', async (_req, res) => {
  const [stats, order] = await Promise.all([getStats(), getRankedProviders()]);
  res.json({
    stats,
    order,
    cooldowns: getAllCooldowns(),
    primary: config.ai.provider,
    providers: ALL_PROVIDERS,
  });
});

botAdminCommandCenterRouter.post('/providers/probe', async (req, res) => {
  const target = String(req.body?.provider ?? 'all').toLowerCase();
  if (target !== 'all' && !(ALL_PROVIDERS as readonly string[]).includes(target)) {
    res.status(400).json({ error: 'Unbekannter Provider.' });
    return;
  }
  const targets: ProviderName[] = target === 'all' ? [...ALL_PROVIDERS] : [target as ProviderName];
  const results = await Promise.all(targets.map(async provider => ({
    provider,
    ...(await probeProvider(provider)),
  })));
  audit(req, 'BOTADMIN_AI_PROVIDER_PROBE', 'AI', { target });
  res.json({ results });
});

botAdminCommandCenterRouter.post('/providers/reset', async (req, res) => {
  const target = String(req.body?.provider ?? '').toLowerCase();
  if (req.body?.confirm !== 'RESET') {
    res.status(400).json({ error: 'Bestätigung RESET erforderlich.' });
    return;
  }
  if (target !== 'all' && !(ALL_PROVIDERS as readonly string[]).includes(target)) {
    res.status(400).json({ error: 'Unbekannter Provider.' });
    return;
  }
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
// ADMIN-FEEDBACK: Channel-Konfiguration + Notify-Refresh
// ---------------------------------------------------------------------------
botAdminCommandCenterRouter.get('/feedback-channel', async (req, res) => {
  const guildId = typeof req.query.guildId === 'string' && SNOWFLAKE.test(req.query.guildId)
    ? req.query.guildId
    : null;
  const [globalCfg, profile] = await Promise.all([
    prisma.botConfig.findUnique({ where: { key: 'globalFeedbackChannelId' } }),
    guildId
      ? prisma.guildProfile.findUnique({
          where: { guildId },
          select: { guildId: true, feedbackChannelId: true },
        })
      : Promise.resolve(null),
  ]);

  let channelOptions: Array<{ id: string; name: string; type: ChannelType }> = [];
  if (guildId) {
    const client = tryGetDashboardClient();
    if (!client) {
      res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
      return;
    }
    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      res.status(404).json({ error: 'Bot ist auf dem ausgewählten Server nicht verfügbar.' });
      return;
    }
    channelOptions = guild.channels.cache
      .filter(channel => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
      .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  res.json({
    globalChannelId: typeof globalCfg?.value === 'string' ? globalCfg.value : null,
    guildChannelId: profile?.feedbackChannelId ?? null,
    channelOptions,
  });
});

botAdminCommandCenterRouter.put('/feedback-channel', async (req, res) => {
  const scope = req.body?.scope === 'global' ? 'global' : 'guild';
  const channelId = typeof req.body?.channelId === 'string' && req.body.channelId.trim()
    ? req.body.channelId.trim()
    : null;
  if (channelId && !SNOWFLAKE.test(channelId)) {
    res.status(400).json({ error: 'Ungültige channelId.' });
    return;
  }
  if (scope === 'global') {
    if (!isBotOwnerRequest(req)) {
      res.status(403).json({ error: 'Nur der Bot-Owner darf den globalen Feedback-Channel setzen.' });
      return;
    }
    if (channelId) {
      const invalid = await feedbackChannelValidationError(channelId);
      if (invalid) {
        res.status(invalid.status).json({ error: invalid.error });
        return;
      }
    }
    await prisma.botConfig.upsert({
      where: { key: 'globalFeedbackChannelId' },
      create: {
        key: 'globalFeedbackChannelId',
        value: channelId ?? Prisma.JsonNull,
        category: 'feedback',
        description: 'Owner-Fallback-Channel für /feedback.',
        updatedBy: actor(req),
      },
      update: { value: channelId ?? Prisma.JsonNull, updatedBy: actor(req) },
    });
    audit(req, 'FEEDBACK_GLOBAL_CHANNEL_SET', 'ADMIN', { channelId });
    res.json({ ok: true });
    return;
  }

  const guildId = String(req.body?.guildId ?? '');
  if (!SNOWFLAKE.test(guildId)) {
    res.status(400).json({ error: 'Gültige guildId erforderlich.' });
    return;
  }
  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
    return;
  }
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    res.status(400).json({ error: 'Bot ist auf dem ausgewählten Server nicht verfügbar.' });
    return;
  }
  if (channelId) {
    const invalid = await feedbackChannelValidationError(channelId, guildId);
    if (invalid) {
      res.status(invalid.status).json({ error: invalid.error });
      return;
    }
  }
  await prisma.guildProfile.upsert({
    where: { guildId },
    create: { guildId, name: guild.name, feedbackChannelId: channelId },
    update: { feedbackChannelId: channelId },
  });
  audit(req, 'FEEDBACK_CHANNEL_SET', 'ADMIN', { guildId, channelId });
  res.json({ ok: true });
});

botAdminCommandCenterRouter.patch('/feedback/:id', async (req, res) => {
  const feedback = await prisma.feedback.findUnique({ where: { id: String(req.params.id) } });
  if (!feedback) {
    res.status(404).json({ error: 'Feedback nicht gefunden.' });
    return;
  }

  const status = req.body?.status === undefined
    ? feedback.status
    : String(req.body.status).toUpperCase();
  if (!['OPEN', 'IN_REVIEW', 'RESOLVED', 'WONTFIX'].includes(status)) {
    res.status(400).json({ error: 'Ungültiger Status.' });
    return;
  }
  const adminNote = req.body?.adminNote === undefined
    ? feedback.adminNote
    : String(req.body.adminNote).slice(0, 2000);
  const updated = await prisma.feedback.update({
    where: { id: feedback.id },
    data: {
      status: status as never,
      adminNote,
      reviewedBy: actor(req),
      reviewedAt: new Date(),
    },
  });

  if (updated.notifyChannelId && updated.notifyMessageId) {
    const client = tryGetDashboardClient();
    try {
      const channel = await client?.channels.fetch(updated.notifyChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(updated.notifyMessageId).catch(() => null);
        if (message) {
          const embed = new EmbedBuilder()
            .setTitle(`${updated.category} • ${updated.subject}`)
            .setDescription(updated.message.slice(0, 3500))
            .addFields(
              { name: 'Von', value: `<@${updated.userId}>`, inline: true },
              { name: 'Status', value: `\`${updated.status}\``, inline: true },
            );
          if (updated.adminNote) {
            embed.addFields({ name: 'Admin-Notiz', value: updated.adminNote.slice(0, 1024) });
          }
          await message.edit({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => undefined);
        }
      }
    } catch (error) {
      logger.warn('BotAdmin Feedback Notify-Refresh fehlgeschlagen', {
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  audit(req, 'BOTADMIN_FEEDBACK_UPDATE', 'ADMIN', {
    feedbackId: feedback.id,
    status,
    noteChanged: adminNote !== feedback.adminNote,
  });
  res.json(updated);
});