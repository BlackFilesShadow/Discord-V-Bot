import { Router } from 'express';
import prisma from '../../../database/prisma';
import { errorCounter } from '../../../utils/metrics';
import { queryLogRing } from '../../services/observability';
import { redactAuditDetails } from '../../../utils/auditRedaction';
import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';

export const devDiagnosticsStubsRouter = Router();

function redactDiagnosticText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactAuditDetails(String(value));
  return typeof redacted === 'string' ? redacted : '[REDACTED]';
}

function redactSerializedMeta(meta: string | undefined): string | undefined {
  if (!meta) return meta;
  try {
    return JSON.stringify(redactAuditDetails(JSON.parse(meta)));
  } catch {
    return redactDiagnosticText(meta) ?? undefined;
  }
}

function maskIp(ip: string | null): string | null {
  if (!ip) return ip;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }
  if (ip.includes(':')) {
    const segments = ip.split(':');
    if (segments.length > 2) return `${segments[0]}:${segments[1]}:::x`;
  }
  return 'x';
}

// Die folgenden Legacy-Stubs lesen bzw. mutieren ausschliesslich globale
// Prozess-/Runtime-Daten. Dieser Adapter ist im v2-Mount bereits hinter
// requireDev + verifiziertem Step-Up, daher ist req.devSession hier die
// serverseitig validierte Autoritaet. Bei globaler Session faellt die Anfrage
// unveraendert in devStubsRouter durch.
devDiagnosticsStubsRouter.use((req, res, next) => {
  const path = req.path;
  const globalOnly = path === '/server-stats'
    || path === '/commands'
    || path === '/debug'
    || path.startsWith('/debug/');
  if (globalOnly && rejectGlobalOnlyForRestrictedSession(req, res)) return;
  next();
});

// Globale Log-Ring-Daten lassen sich nicht verlaesslich einer Guild zuordnen.
// In einer guildIdRestrict-Session werden sie deshalb fail-closed verweigert.
// Im globalen Modus wird jede Zeile vor der Ausgabe erneut rekursiv redigiert.
devDiagnosticsStubsRouter.get('/errors', async (req, res) => {
  if (rejectGlobalOnlyForRestrictedSession(req, res)) return;

  const metric = await errorCounter.get();
  const bySource = metric.values.map(value => ({
    source: String(value.labels.source ?? 'unknown'),
    count: Number(value.value),
  }));
  const recent = queryLogRing({ level: 'error', limit: 200 }).map(entry => ({
    ...entry,
    message: redactDiagnosticText(entry.message) ?? '[REDACTED]',
    meta: redactSerializedMeta(entry.meta),
  }));
  const webhookEnabled = (process.env.ERROR_WEBHOOK_URL ?? '').startsWith('https://discord.com/api/webhooks/');

  res.json({
    bySource,
    totalCount: bySource.reduce((sum, row) => sum + row.count, 0),
    recent,
    webhookEnabled,
    generatedAt: new Date().toISOString(),
    scope: { global: true },
  });
});

// Sync-Diagnose ist bei eingeschraenkter DevSession exakt auf die Guild
// begrenzt. Der Gesamtzaehler wird separat gezaehlt und ist damit nicht mehr
// faelschlich auf die Top-20-Guilds begrenzt.
devDiagnosticsStubsRouter.get('/sync', async (req, res) => {
  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  const nitradoWhere = restrict ? { guildId: restrict } : undefined;
  const linkWhere = restrict ? { guildId: restrict, status: 'VERIFIED' as const } : { status: 'VERIFIED' as const };

  const [nitradoStatus, nitradoOpsRaw, nitradoFailedSamples, linksByGuild, linkTotal] = await Promise.all([
    prisma.nitradoJob.groupBy({
      by: ['status'],
      _count: { _all: true },
      where: nitradoWhere,
    }),
    prisma.nitradoJob.groupBy({
      by: ['operation'],
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 10,
      where: nitradoWhere,
    }),
    prisma.nitradoJob.findMany({
      where: { status: 'FAILED', ...(restrict ? { guildId: restrict } : {}) },
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, guildId: true, operation: true, attempts: true, lastError: true, updatedAt: true },
    }),
    prisma.gameIdentityLink.groupBy({
      by: ['guildId'],
      where: linkWhere,
      _count: { _all: true },
      orderBy: { _count: { id: 'desc' } },
      take: 20,
    }),
    prisma.gameIdentityLink.count({ where: linkWhere }),
  ]);

  res.json({
    nitrado: {
      byStatus: nitradoStatus.map(row => ({ status: row.status, count: row._count._all })),
      byOperation: nitradoOpsRaw.map(row => ({ operation: row.operation, count: row._count._all })),
      recentFailed: nitradoFailedSamples.map(row => ({
        ...row,
        lastError: redactDiagnosticText(row.lastError),
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
    economyLinks: {
      byGuild: linksByGuild.map(row => ({ guildId: row.guildId, count: row._count._all })),
      total: linkTotal,
    },
    generatedAt: new Date().toISOString(),
    scope: restrict ? { guildIdRestrict: restrict } : { global: true },
  });
});

// SecurityEvents sind aktuell global und besitzen keinen belastbaren Guild-Key.
// Eine eingeschraenkte DEV-Session darf deshalb nicht auf diese Cross-Guild-
// Forensik zugreifen.
devDiagnosticsStubsRouter.get('/security', async (req, res) => {
  if (rejectGlobalOnlyForRestrictedSession(req, res)) return;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [eventsByType, recentEvents, activeDevSessions] = await Promise.all([
    prisma.securityEvent.groupBy({
      by: ['eventType', 'severity'],
      _count: { _all: true },
      where: { createdAt: { gte: since } },
    }),
    prisma.securityEvent.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        eventType: true,
        severity: true,
        description: true,
        ipAddress: true,
        createdAt: true,
      },
    }),
    prisma.devSession.count({
      where: { revokedAt: null, expiresAt: { gt: new Date() } },
    }),
  ]);

  const bruteForceLast24h = eventsByType
    .filter(row => row.eventType === 'BRUTE_FORCE')
    .reduce((sum, row) => sum + row._count._all, 0);
  const loginFailLast24h = eventsByType
    .filter(row => row.eventType === 'LOGIN_FAILURE')
    .reduce((sum, row) => sum + row._count._all, 0);

  res.json({
    windowHours: 24,
    activeDevSessions,
    bruteForceLast24h,
    loginFailLast24h,
    eventsByType: eventsByType.map(row => ({
      eventType: row.eventType, severity: row.severity, count: row._count._all,
    })),
    recentEvents: recentEvents.map(row => ({
      ...row,
      description: redactDiagnosticText(row.description) ?? '[REDACTED]',
      ipAddress: maskIp(row.ipAddress),
      createdAt: row.createdAt.toISOString(),
    })),
    generatedAt: new Date().toISOString(),
    scope: { global: true },
  });
});
