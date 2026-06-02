/**
 * DEV-Status-Endpoints (Phase 3).
 *
 * Liefert aggregierte Diagnose-Daten fuer:
 *  - GET /database     Postgres-Pool, Latenz, Migrations, top tables
 *  - GET /discord      Gateway-Status, Shard-Latenzen, Cache-Sizes
 *  - GET /nitrado      NitradoJob-Outbox-Statistik
 *  - GET /adm          ADM-Sync-Status + persistenter Cursor pro Connection
 *  - GET /system       CPU, RAM, Disk, Load, Process-Memory
 *  - GET /ai-providers Provider-Stats + Anomalie-Befunde (Spec 9)
 *
 * Alle Routen erfordern requireDev. Antworten enthalten KEINE Secrets:
 * Connection-Strings, Tokens und API-Keys werden niemals zurueckgegeben.
 */
import { Router } from 'express';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { requireDev } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logger } from '../../../utils/logger';
import { getStats } from '../../../modules/ai/providerStats';
import { nitradoWriteProtectionStatus } from '../../middleware/nitradoWriteGuard';
import { config } from '../../../config';

export const devStatusRouter = Router();
devStatusRouter.use(requireDev);

// --- Helpers --------------------------------------------------------------

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T | null; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const value = await fn();
    return { value, ms: Date.now() - start };
  } catch (e) {
    return { value: null, ms: Date.now() - start, error: (e as Error).message };
  }
}

// --- Database -------------------------------------------------------------

devStatusRouter.get('/database', async (_req, res) => {
  const ping = await timed(async () => {
    const r = await prisma.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok');
    return r[0]?.ok === 1;
  });

  const tables = await timed(async () => {
    return prisma.$queryRawUnsafe<Array<{ relname: string; n_live_tup: bigint; n_dead_tup: bigint }>>(`
      SELECT relname, n_live_tup, n_dead_tup
      FROM pg_stat_user_tables
      ORDER BY n_live_tup DESC
      LIMIT 25
    `);
  });

  const dbSize = await timed(async () => {
    const r = await prisma.$queryRawUnsafe<Array<{ size: string; bytes: bigint }>>(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
             pg_database_size(current_database()) AS bytes
    `);
    return r[0];
  });

  const conns = await timed(async () => {
    const r = await prisma.$queryRawUnsafe<Array<{ state: string; count: bigint }>>(`
      SELECT state, count(*)::bigint AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY state
    `);
    return r;
  });

  const migrations = await timed(async () => {
    const r = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `).catch(() => [{ count: BigInt(0) }]);
    return Number(r[0]?.count ?? 0);
  });

  res.json({
    ok: ping.value === true,
    pingMs: ping.ms,
    pingError: ping.error,
    sizePretty: dbSize.value?.size ?? null,
    sizeBytes: dbSize.value ? Number(dbSize.value.bytes) : null,
    migrationsApplied: migrations.value ?? 0,
    connections: (conns.value ?? []).map(c => ({ state: c.state, count: Number(c.count) })),
    topTables: (tables.value ?? []).map(t => ({
      name: t.relname,
      liveRows: Number(t.n_live_tup),
      deadRows: Number(t.n_dead_tup),
    })),
  });
});

// --- Discord --------------------------------------------------------------

devStatusRouter.get('/discord', (_req, res) => {
  const client = tryGetDashboardClient();
  if (!client) return res.json({ ok: false, error: 'Discord-Client nicht gebunden.' });

  const wsStatus = client.ws.status;
  const wsPing = client.ws.ping;
  const shards = Array.from(client.ws.shards.values()).map(s => ({
    id: s.id,
    status: s.status,
    pingMs: s.ping,
  }));
  res.json({
    ok: wsStatus === 0, // Status.Ready === 0
    statusCode: wsStatus,
    averagePingMs: wsPing,
    shards,
    cache: {
      guilds: client.guilds.cache.size,
      users: client.users.cache.size,
      channels: client.channels.cache.size,
    },
    user: client.user ? { id: client.user.id, tag: client.user.tag } : null,
  });
});

// --- Nitrado --------------------------------------------------------------

devStatusRouter.get('/nitrado', async (req, res) => {
  // Multi-Guild-Schutz (P0): Wenn die DevSession einen guildIdRestrict
  // gesetzt hat, NUR Daten dieser Guild aggregieren. Sonst global view.
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  const baseWhere = restrict ? { guildId: restrict } : undefined;

  const counts = await timed(async () => {
    // DEV-only globaler Worker-View ueber alle Guilds. requireDev gateway haelt
    // nicht-Developer raus, daher bewusst kein guildId-Filter (oder restrict).
    // eslint-disable-next-line local/no-unscoped-prisma-query
    const rows = await prisma.nitradoJob.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: baseWhere,
    });
    const out: Record<string, number> = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0, DEAD: 0 };
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  });

  const recentFailures = await timed(async () => {
    // eslint-disable-next-line local/no-unscoped-prisma-query
    return prisma.nitradoJob.findMany({
      where: { status: { in: ['FAILED', 'DEAD'] }, ...(restrict ? { guildId: restrict } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, operation: true, guildId: true, status: true, attempts: true, lastError: true, updatedAt: true },
    });
  });

  const oldestPending = await timed(async () => {
    // eslint-disable-next-line local/no-unscoped-prisma-query
    return prisma.nitradoJob.findFirst({
      where: { status: 'PENDING', ...(restrict ? { guildId: restrict } : {}) },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    });
  });

  res.json({
    counts: counts.value ?? {},
    queryMs: counts.ms,
    recentFailures: recentFailures.value ?? [],
    oldestPendingAt: oldestPending.value?.createdAt ?? null,
    oldestPendingAgeSec: oldestPending.value ? Math.round((Date.now() - oldestPending.value.createdAt.getTime()) / 1000) : null,
    scope: restrict ? { guildIdRestrict: restrict } : { global: true },
  });
});

// --- ADM-Sync-Status ------------------------------------------------------
// Zeigt den persistenten ADM-Cursor (NitradoAdmCursor) pro aktiver Connection.
// KEINE Secrets: Token wird niemals geladen/zurueckgegeben — nur Alias, Slot,
// Service-ID und der Cursor-Stand. Respektiert guildIdRestrict wie /nitrado.
devStatusRouter.get('/adm', async (req, res) => {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  const admDir = process.env.NITRADO_ADM_DIR ?? null;

  const data = await timed(async () => {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate; optional auf restrict beschraenkt.
    const conns = await prisma.nitradoConnection.findMany({
      where: { status: 'ACTIVE', ...(restrict ? { guildId: restrict } : {}) },
      select: { id: true, guildId: true, slot: true, alias: true, alias5: true, nitradoServerId: true, serviceId: true },
      orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
    });
    if (conns.length === 0) return [];

    const cursors = await prisma.nitradoAdmCursor.findMany({
      where: { nitradoConnId: { in: conns.map(c => c.id) } },
      select: { nitradoConnId: true, lastModifiedAt: true, lastFileName: true, updatedAt: true },
    });
    const byConn = new Map(cursors.map(c => [c.nitradoConnId, c]));

    return conns.map(c => {
      const cur = byConn.get(c.id);
      return {
        nitradoConnId: c.id,
        guildId: c.guildId,
        slot: c.slot,
        alias: c.alias,
        alias5: c.alias5,
        serviceId: c.serviceId ?? c.nitradoServerId ?? null,
        admLinked: !!c.nitradoServerId,
        cursor: cur
          ? {
              lastModifiedAt: cur.lastModifiedAt,
              lastModifiedIso: new Date(cur.lastModifiedAt * 1000).toISOString(),
              lastFileName: cur.lastFileName,
              updatedAt: cur.updatedAt,
            }
          : null,
      };
    });
  });

  res.json({
    admDirConfigured: !!admDir,
    intervalMin: 15,
    queryMs: data.ms,
    connections: data.value ?? [],
    scope: restrict ? { guildIdRestrict: restrict } : { global: true },
  });
});

// --- Nitrado Write-Protection (Spec §12) ----------------------------------
// Read-only Status: ist der Schreibschutz aktiv, welche Scopes existieren,
// und wie viele Long-Life-Token-Connections sind verknuepft (OHNE Token-Werte).
devStatusRouter.get('/nitrado-protection', async (req, res) => {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  const status = nitradoWriteProtectionStatus();

  const data = await timed(async () => {
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate; optional auf restrict beschraenkt.
    const conns = await prisma.nitradoConnection.findMany({
      where: { ...(restrict ? { guildId: restrict } : {}) },
      select: { id: true, guildId: true, slot: true, status: true, nitradoServerId: true, serviceId: true, lastValidatedAt: true },
      orderBy: [{ guildId: 'asc' }, { slot: 'asc' }],
    });
    const linked = conns.filter(c => !!c.nitradoServerId).length;
    const active = conns.filter(c => c.status === 'ACTIVE').length;
    return {
      connectionsTotal: conns.length,
      connectionsActive: active,
      connectionsWithService: linked,
      // KEINE Token-Werte — nur ob eine Service-ID hinterlegt ist.
      services: conns.map(c => ({
        guildId: c.guildId,
        slot: c.slot,
        status: c.status,
        serviceId: c.serviceId ?? c.nitradoServerId ?? null,
        serviceLinked: !!c.nitradoServerId,
        lastValidatedAt: c.lastValidatedAt,
      })),
    };
  });

  res.json({
    writeProtection: status.writeProtection,
    scopes: status.scopes,
    readOnlyCaptureActive: true,
    queryMs: data.ms,
    nitrado: data.value ?? null,
    scope: restrict ? { guildIdRestrict: restrict } : { global: true },
  });
});

// --- Member-Erfassung (Spec §11) ------------------------------------------

devStatusRouter.get('/member-detection', async (req, res) => {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  const client = tryGetDashboardClient();

  // Discord-Cache-Sicht (keine Full-Fetches im Request-Pfad — nur Cache).
  const guildsView = client
    ? Array.from(client.guilds.cache.values())
        .filter(g => !restrict || g.id === restrict)
        .map(g => ({
          guildId: g.id,
          name: g.name,
          memberCount: g.memberCount,
          cachedMembers: g.members.cache.size,
          roleCount: g.roles.cache.size - 1, // @everyone abziehen
        }))
        .sort((a, b) => b.memberCount - a.memberCount)
    : [];

  const dbStats = await timed(async () => {
    const where = restrict ? { guildId: restrict } : {};
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate; optional auf restrict beschraenkt.
    const total = await prisma.guildMemberProfile.count({ where });
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate.
    const left = await prisma.guildMemberProfile.count({ where: { ...where, isLeft: true } });
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate.
    const boosting = await prisma.guildMemberProfile.count({ where: { ...where, isBoosting: true } });
    // eslint-disable-next-line local/no-unscoped-prisma-query -- DEV-globaler Worker-View; requireDev-Gate.
    const recent = await prisma.guildMemberProfile.findMany({
      where,
      select: { guildId: true, discordId: true, username: true, nickname: true, isLeft: true, joinedAt: true, lastSeenAt: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    });
    return { total, left, boosting, active: total - left, recent };
  });

  res.json({
    intents: { guildMembers: true },
    sync: {
      enabled: config.member.syncEnabled,
      intervalHours: config.member.syncIntervalHours,
    },
    guildsTotal: guildsView.length,
    guilds: guildsView,
    indexed: dbStats.value
      ? { total: dbStats.value.total, active: dbStats.value.active, left: dbStats.value.left, boosting: dbStats.value.boosting }
      : { total: 0, active: 0, left: 0, boosting: 0 },
    recentMembers: (dbStats.value?.recent ?? []).map(m => ({
      guildId: m.guildId,
      discordId: m.discordId,
      username: m.username ?? null,
      nickname: m.nickname ?? null,
      isLeft: m.isLeft,
      joinedAt: m.joinedAt,
      lastSeenAt: m.lastSeenAt,
      updatedAt: m.updatedAt,
    })),
    queryMs: dbStats.ms,
    clientReady: !!client,
    scope: restrict ? { guildIdRestrict: restrict } : { global: true },
  });
});

// --- System ---------------------------------------------------------------

async function readDiskUsage(): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const s = await fs.statfs('/');
    return { totalBytes: s.bsize * s.blocks, freeBytes: s.bsize * s.bfree };
  } catch {
    return null;
  }
}

devStatusRouter.get('/system', async (_req, res) => {
  const mem = process.memoryUsage();
  const cpus = os.cpus();
  const load = os.loadavg();
  const disk = await readDiskUsage();
  res.json({
    process: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      uptimeSec: Math.round(os.uptime()),
      totalMemBytes: os.totalmem(),
      freeMemBytes: os.freemem(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model ?? 'unknown',
      loadAvg: { '1m': load[0], '5m': load[1], '15m': load[2] },
    },
    disk,
  });
});

// --- AI-Providers + Anomaly-Detection (Spec 9) ----------------------------

interface ProviderAnomaly {
  provider: string;
  reason: 'high_failure_rate' | 'high_rate_limit' | 'high_latency' | 'stale' | 'no_calls';
  severity: 'warn' | 'error';
  details: Record<string, unknown>;
}

const STALE_HOURS = 24;
const HIGH_FAILURE_RATIO = 0.3;        // > 30% failures
const HIGH_RATELIMIT_RATIO = 0.2;      // > 20% rate-limited
const HIGH_LATENCY_MS = 8000;          // > 8s avg

function detectAnomalies(stats: Awaited<ReturnType<typeof getStats>>): ProviderAnomaly[] {
  const out: ProviderAnomaly[] = [];
  const now = Date.now();
  for (const s of stats) {
    if (!s.configured) continue;
    const total = s.successCount + s.failureCount + s.rateLimitCount;
    if (total === 0) {
      out.push({ provider: s.provider, reason: 'no_calls', severity: 'warn', details: { configured: true } });
      continue;
    }
    const failureRatio = s.failureCount / total;
    const rlRatio = s.rateLimitCount / total;
    if (failureRatio >= HIGH_FAILURE_RATIO) {
      out.push({
        provider: s.provider, reason: 'high_failure_rate', severity: 'error',
        details: { failureRatio: +failureRatio.toFixed(3), failures: s.failureCount, total, lastError: s.lastError },
      });
    }
    if (rlRatio >= HIGH_RATELIMIT_RATIO) {
      out.push({
        provider: s.provider, reason: 'high_rate_limit', severity: 'warn',
        details: { rateLimitRatio: +rlRatio.toFixed(3), rateLimits: s.rateLimitCount, total },
      });
    }
    if (s.avgLatencyMs >= HIGH_LATENCY_MS) {
      out.push({
        provider: s.provider, reason: 'high_latency', severity: 'warn',
        details: { avgLatencyMs: s.avgLatencyMs },
      });
    }
    const lastActivity = s.lastSuccessAt ?? s.lastFailureAt;
    if (lastActivity && now - lastActivity.getTime() > STALE_HOURS * 60 * 60 * 1000) {
      out.push({
        provider: s.provider, reason: 'stale', severity: 'warn',
        details: { lastActivity: lastActivity.toISOString(), hoursSince: Math.round((now - lastActivity.getTime()) / 3600000) },
      });
    }
  }
  return out;
}

devStatusRouter.get('/ai-providers', async (_req, res) => {
  try {
    const stats = await getStats();
    const anomalies = detectAnomalies(stats);
    res.json({
      providers: stats.map(s => ({
        provider: s.provider,
        configured: s.configured,
        successCount: s.successCount,
        failureCount: s.failureCount,
        rateLimitCount: s.rateLimitCount,
        avgLatencyMs: s.avgLatencyMs,
        successRate: +s.successRate.toFixed(4),
        lastSuccessAt: s.lastSuccessAt,
        lastFailureAt: s.lastFailureAt,
        lastError: s.lastError,
      })),
      anomalies,
      thresholds: {
        highFailureRatio: HIGH_FAILURE_RATIO,
        highRateLimitRatio: HIGH_RATELIMIT_RATIO,
        highLatencyMs: HIGH_LATENCY_MS,
        staleHours: STALE_HOURS,
      },
    });
  } catch (err) {
    logger.error('[DEV-Status] ai-providers failed', err as Error);
    res.status(500).json({ error: 'Provider-Stats konnten nicht geladen werden.' });
  }
});
