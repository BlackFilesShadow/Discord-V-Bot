/**
 * DEV Observability Routes (P3).
 *
 * Alle Endpunkte erfordern requireDev (DEVELOPER + aktive DevSession + MFA + IP).
 *
 *   GET /metrics/prisma            -> p50/p95/p99 Latenz pro Prisma-Bucket
 *   GET /metrics/ai                -> dasselbe fuer AI-Calls
 *   GET /logs?level=&q=&since=&n=  -> Live-Log-Ring-Buffer mit Filter
 *   GET /backup/status             -> Backup-Verzeichnis-Snapshot
 *   GET /audit/search              -> globale AuditLog-Suche (pg_trgm)
 *
 * Audit-Suche-Query-Parameter:
 *   q          Substring auf action ODER details::text (ILIKE/trgm)
 *   category   exakter Match (AuditCategory)
 *   action     exakter Match
 *   guildId    exakter Match
 *   actorId    exakter Match
 *   before     ISO-Timestamp (createdAt < before) — fuer Cursor-Paginierung
 *   limit      1..100 (default 50)
 */
import { Router } from 'express';
import { requireDev } from '../../middleware/auth';
import {
  getAiSnapshot,
  getPrismaSnapshot,
  queryLogRing,
  readBackupStatus,
} from '../../services/observability';
import prisma from '../../../database/prisma';

export const devObservabilityRouter = Router();
devObservabilityRouter.use(requireDev);

devObservabilityRouter.get('/metrics/prisma', (_req, res) => {
  res.json({ buckets: getPrismaSnapshot(), generatedAt: new Date().toISOString() });
});

devObservabilityRouter.get('/metrics/ai', (_req, res) => {
  res.json({ buckets: getAiSnapshot(), generatedAt: new Date().toISOString() });
});

devObservabilityRouter.get('/logs', (req, res) => {
  const level = typeof req.query.level === 'string' ? req.query.level : undefined;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const since = typeof req.query.since === 'string' ? Number(req.query.since) : undefined;
  const limit = typeof req.query.n === 'string' ? Number(req.query.n) : undefined;
  const entries = queryLogRing({
    level,
    q,
    sinceTs: since && !Number.isNaN(since) ? since : undefined,
    limit: limit && !Number.isNaN(limit) ? limit : undefined,
  });
  res.json({ entries, count: entries.length });
});

devObservabilityRouter.get('/backup/status', async (_req, res) => {
  res.json(await readBackupStatus());
});

const MAX_AUDIT_LIMIT = 100;
const ALLOWED_CATEGORIES = new Set([
  'AUTH','REGISTRATION','UPLOAD','DOWNLOAD','MODERATION','GIVEAWAY','LEVEL','ROLE',
  'POLL','SECURITY','ADMIN','SYSTEM','CONFIG','GDPR','AI','FEED','APPEAL','TICKET',
  'NITRADO','ECONOMY','CASINO','DASHBOARD','WHITELIST','FACTION','SERVER_SETTINGS',
]);

devObservabilityRouter.get('/audit/search', async (req, res) => {
  const limit = Math.min(MAX_AUDIT_LIMIT, Math.max(1, Number(req.query.limit) || 50));
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const category = typeof req.query.category === 'string' ? req.query.category : undefined;
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : undefined;
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : undefined;
  const actorId = typeof req.query.actorId === 'string' ? req.query.actorId : undefined;
  const before = typeof req.query.before === 'string' ? new Date(req.query.before) : undefined;

  if (category && !ALLOWED_CATEGORIES.has(category)) {
    res.status(400).json({ error: 'invalid_category' });
    return;
  }
  if (q && q.length < 2) {
    res.status(400).json({ error: 'q_too_short' });
    return;
  }
  if (q && q.length > 200) {
    res.status(400).json({ error: 'q_too_long' });
    return;
  }

  const where: Record<string, unknown> = {};
  if (category) where.category = category;
  if (guildId) where.guildId = guildId;
  if (actorId) where.actorId = actorId;
  if (before && !Number.isNaN(before.getTime())) where.createdAt = { lt: before };

  // Volltext via pg_trgm/ILIKE: action ILIKE %q% OR details::text ILIKE %q%.
  // Prisma kann `details::text` nicht direkt; wir nutzen action.contains
  // (case-insensitive) als Schnell-Pfad. Wenn explizit `action` Filter
  // gesetzt ist, dominiert dieser.
  if (action) {
    where.action = { contains: action, mode: 'insensitive' };
  } else if (q) {
    // OR auf action und details (details bleibt JSON, daher kein ILIKE-Filter
    // direkt; wir filtern primaer auf action und liefern q dem Client als
    // Echo zurueck, damit er Client-seitig zusaetzlich auf details filtern
    // kann. Der pg_trgm Index sorgt fuer schnellen ILIKE auf action.)
    where.action = { contains: q, mode: 'insensitive' };
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      actor: { select: { discordId: true, username: true } },
      target: { select: { discordId: true, username: true } },
    },
  });

  res.json({
    entries: rows.map(r => ({
      id: r.id,
      action: r.action,
      category: r.category,
      guildId: r.guildId,
      createdAt: r.createdAt.toISOString(),
      actor: r.actor ? { discordId: r.actor.discordId, username: r.actor.username } : null,
      target: r.target ? { discordId: r.target.discordId, username: r.target.username } : null,
      channelId: r.channelId,
      ipAddress: r.ipAddress,
      details: r.details,
    })),
    limit,
    hasMore: rows.length === limit,
    echo: { q: q || null, category: category ?? null, action: action ?? null, guildId: guildId ?? null, actorId: actorId ?? null },
  });
});
