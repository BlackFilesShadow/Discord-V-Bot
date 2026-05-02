/**
 * P4 — DEV Stub-Pages: Live-Daten-Backend.
 *
 * Liefert die echten Daten fuer die letzten verbliebenen Stub-Seiten:
 *
 *   GET /server-stats        Dashboard-Status: Uptime, Sessions, Sockets, Prisma-Top
 *   GET /errors              Error-Monitoring: errorCounter aus Prom + letzte Error-Logs
 *   GET /sync                Live-Sync: NitradoJob-Outbox + EconomyLink-Counts
 *   GET /security            Security-Status: SecurityEvents 24h, DevSessions, BruteForce
 *   GET /debug               Debug-Tools: Heap, EventLoop-Lag, GC, V8 Stats
 *   POST /debug/heap-snapshot  Schreibt Heap-Snapshot in os.tmpdir() (Audit + StepUp)
 *   GET /commands            Command-Diag: Slash-Command-Registry des Discord-Clients
 *
 * Alle Endpoints requireDev (DEVELOPER + DevSession + MFA + IP-Allow).
 * Mutating /debug/heap-snapshot zusaetzlich validateStepUpInput.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { requireDev } from '../../middleware/auth';
import { validateStepUpInput } from '../../middleware/devSecurity';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { getIo } from '../../socket/emitter';
import { getPrismaSnapshot, queryLogRing } from '../../services/observability';
import { errorCounter } from '../../../utils/metrics';
import { logger, logAudit, logAuditDb } from '../../../utils/logger';

export const devStubsRouter = Router();
devStubsRouter.use(requireDev);

// EventLoop-Histogramm laeuft permanent, damit Mittelwert+Max sinnvoll sind.
const eldHist = monitorEventLoopDelay({ resolution: 20 });
eldHist.enable();

// Heap-Snapshots sind ressourcen-intensiv (sync I/O + heap-walk):
// max 3 pro 10 Minuten je IP, um Self-DoS zu verhindern.
const heapSnapshotLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Zu viele Heap-Snapshots in Folge.' },
});

// ----------------------------------------------------------------------------
// 1. dashboard-status
// ----------------------------------------------------------------------------
devStubsRouter.get('/server-stats', async (_req, res) => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  // PgStore-Tabelle ist `session` (connect-pg-simple).
  let activeSessions = 0;
  try {
    const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
      'SELECT count(*)::bigint AS c FROM session WHERE expire > NOW()',
    );
    activeSessions = Number(rows[0]?.c ?? 0);
  } catch (e) {
    logger.debug('server-stats: session-count nicht verfuegbar', { err: (e as Error).message });
  }
  // Aktive DevSessions
  const activeDevSessions = await prisma.devSession.count({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
  });
  // Socket.IO-Verbindungen je Namespace
  const io = getIo();
  const sockets = {
    dev: io ? (io.of('/dev').sockets.size ?? 0) : 0,
    guild: io ? (io.of('/guild').sockets.size ?? 0) : 0,
  };
  // Top 10 Prisma-Buckets nach totalCount
  const topPrisma = getPrismaSnapshot().slice(0, 10);

  res.json({
    uptimeSec: Math.round(process.uptime()),
    nodeVersion: process.version,
    pid: process.pid,
    memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
    cpu: { userMs: cpu.user / 1000, systemMs: cpu.system / 1000 },
    sessions: { http: activeSessions, dev: activeDevSessions },
    sockets,
    topPrisma,
    generatedAt: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// 2. error-monitoring
// ----------------------------------------------------------------------------
devStubsRouter.get('/errors', async (_req, res) => {
  // Prom-Counter pro source einsammeln.
  const metric = await errorCounter.get();
  const bySource = metric.values.map(v => ({
    source: String(v.labels.source ?? 'unknown'),
    count: Number(v.value),
  }));
  // Recent error log lines aus Ring-Buffer.
  const recent = queryLogRing({ level: 'error', limit: 200 });
  // Webhook-Konfig-Status (no leak, nur boolean).
  const webhookEnabled = (process.env.ERROR_WEBHOOK_URL ?? '').startsWith('https://discord.com/api/webhooks/');
  res.json({
    bySource,
    totalCount: bySource.reduce((s, r) => s + r.count, 0),
    recent,
    webhookEnabled,
    generatedAt: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// 3. live-sync
// ----------------------------------------------------------------------------
devStubsRouter.get('/sync', async (_req, res) => {
  // NitradoJob-Aggregate (DEV-only, globaler Outbox-Health-Snapshot)
  // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-Portal: globale Outbox-Aggregation, requireDev geschuetzt.
  const nitradoStatus = await prisma.nitradoJob.groupBy({
    by: ['status'],
    _count: { _all: true },
  });
  // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-Portal: globale Aggregation.
  const nitradoOpsRaw = await prisma.nitradoJob.groupBy({
    by: ['operation'],
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
    take: 10,
  });
  // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-Portal: globale Failed-Outbox-Sicht.
  const nitradoFailedSamples = await prisma.nitradoJob.findMany({
    where: { status: 'FAILED' },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { id: true, guildId: true, operation: true, attempts: true, lastError: true, updatedAt: true },
  });
  // EconomyLink-Aggregate je Guild (DEV-only)
  // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-Portal: Cross-Guild-Counts gewuenscht.
  const linksByGuild = await prisma.economyLink.groupBy({
    by: ['guildId'],
    _count: { _all: true },
    orderBy: { _count: { id: 'desc' } },
    take: 20,
  });
  res.json({
    nitrado: {
      byStatus: nitradoStatus.map(r => ({ status: r.status, count: r._count._all })),
      byOperation: nitradoOpsRaw.map(r => ({ operation: r.operation, count: r._count._all })),
      recentFailed: nitradoFailedSamples.map(r => ({ ...r, updatedAt: r.updatedAt.toISOString() })),
    },
    economyLinks: {
      byGuild: linksByGuild.map(r => ({ guildId: r.guildId, count: r._count._all })),
      total: linksByGuild.reduce((s, r) => s + r._count._all, 0),
    },
    generatedAt: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// 4. security-status
// ----------------------------------------------------------------------------
devStubsRouter.get('/security', async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const eventsByType = await prisma.securityEvent.groupBy({
    by: ['eventType', 'severity'],
    _count: { _all: true },
    where: { createdAt: { gte: since } },
  });
  const recentEvents = await prisma.securityEvent.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, eventType: true, severity: true, description: true,
      ipAddress: true, createdAt: true,
    },
  });
  const activeDevSessions = await prisma.devSession.count({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
  });
  const bruteForceLast24h = eventsByType
    .filter(r => r.eventType === 'BRUTE_FORCE')
    .reduce((s, r) => s + r._count._all, 0);
  const loginFailLast24h = eventsByType
    .filter(r => r.eventType === 'LOGIN_FAILURE')
    .reduce((s, r) => s + r._count._all, 0);
  res.json({
    windowHours: 24,
    activeDevSessions,
    bruteForceLast24h,
    loginFailLast24h,
    eventsByType: eventsByType.map(r => ({
      eventType: r.eventType, severity: r.severity, count: r._count._all,
    })),
    recentEvents: recentEvents.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })),
    generatedAt: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------------
// 5. debug-tools
// ----------------------------------------------------------------------------
devStubsRouter.get('/debug', (_req, res) => {
  const heap = v8.getHeapStatistics();
  const heapSpaces = v8.getHeapSpaceStatistics().map(s => ({
    name: s.space_name,
    size: s.space_size,
    used: s.space_used_size,
    available: s.space_available_size,
  }));
  // EventLoop-Lag in ms (Histogramm).
  const eld = {
    minMs: eldHist.min / 1e6,
    maxMs: eldHist.max / 1e6,
    meanMs: eldHist.mean / 1e6,
    p50Ms: eldHist.percentile(50) / 1e6,
    p95Ms: eldHist.percentile(95) / 1e6,
    p99Ms: eldHist.percentile(99) / 1e6,
  };
  // Resource utilization deltas
  const ru = process.resourceUsage();
  res.json({
    heap,
    heapSpaces,
    eventLoopDelay: eld,
    resourceUsage: {
      userCPU: ru.userCPUTime / 1000,
      systemCPU: ru.systemCPUTime / 1000,
      maxRSS: ru.maxRSS,
      fsRead: ru.fsRead,
      fsWrite: ru.fsWrite,
    },
    perfNow: performance.now(),
    nodeVersion: process.version,
    generatedAt: new Date().toISOString(),
  });
});

devStubsRouter.post('/debug/heap-snapshot', heapSnapshotLimiter, (req, res) => {
  const reason = String((req.body as { reason?: unknown } | undefined)?.reason ?? '');
  const reAuth = String((req.body as { reAuth?: unknown } | undefined)?.reAuth ?? '');
  const stepUp = validateStepUpInput({ reason, reAuth });
  if (!stepUp.ok) {
    res.status(400).json({ error: stepUp.error });
    return;
  }
  if (!req.auth) { res.status(401).json({ error: 'no_auth' }); return; }
  const dir = process.env.HEAP_SNAPSHOT_DIR || os.tmpdir();
  const file = path.join(dir, `heap-${Date.now()}.heapsnapshot`);
  try {
    v8.writeHeapSnapshot(file);
  } catch (e) {
    logger.error('heap-snapshot fehlgeschlagen', { err: (e as Error).message });
    res.status(500).json({ error: 'snapshot_failed', message: (e as Error).message });
    return;
  }
  logAudit('DEV_HEAP_SNAPSHOT', 'SECURITY', { userId: req.auth.userId, file, reason });
  logAuditDb('DEV_HEAP_SNAPSHOT', 'SECURITY', {
    actorUserId: req.auth.userId,
    details: { file, reason },
    ip: req.ip ?? null,
  });
  res.json({ ok: true, file });
});

// ----------------------------------------------------------------------------
// 6. command-diag
// ----------------------------------------------------------------------------
devStubsRouter.get('/commands', (_req, res) => {
  const client = tryGetDashboardClient();
  if (!client) { res.json({ ready: false, count: 0, commands: [] }); return; }
  // client.commands: Collection<string, { data: SlashCommandBuilder; ... }>
  const collRaw = (client as unknown as { commands?: { entries: () => IterableIterator<[string, unknown]> } }).commands;
  const out: { name: string; description: string; cooldownMs: number | null }[] = [];
  if (collRaw && typeof collRaw.entries === 'function') {
    for (const [name, cmd] of collRaw.entries()) {
      const c = cmd as { data?: { description?: string }; cooldown?: number };
      out.push({
        name,
        description: c.data?.description ?? '',
        cooldownMs: typeof c.cooldown === 'number' ? c.cooldown : null,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ ready: true, count: out.length, commands: out });
});
