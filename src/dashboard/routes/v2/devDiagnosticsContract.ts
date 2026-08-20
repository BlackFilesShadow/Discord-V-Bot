import { Router } from 'express';
import prisma from '../../../database/prisma';
import { requireDev } from '../../middleware/auth';
import { tryGetDashboardClient } from '../../clientRegistry';
import { logger } from '../../../utils/logger';
import { redactAuditDetails } from '../../../utils/auditRedaction';
import { rejectGlobalOnlyForRestrictedSession } from './devDiagnosticScope';

export const devDiagnosticsContractRouter = Router();

function redactDiagnosticText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const redacted = redactAuditDetails(String(value));
  return typeof redacted === 'string' ? redacted : '[REDACTED]';
}

function hardenPassThroughPayload(path: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const obj = body as Record<string, unknown>;

  if (path === '/nitrado') {
    const failures = Array.isArray(obj.recentFailures) ? obj.recentFailures : [];
    return {
      ...obj,
      recentFailures: failures.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const item = row as Record<string, unknown>;
        return { ...item, lastError: redactDiagnosticText(item.lastError) };
      }),
    };
  }

  if (path === '/adm') {
    const connections = Array.isArray(obj.connections) ? obj.connections : [];
    return {
      ...obj,
      connections: connections.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const item = row as Record<string, unknown>;
        const source = item.source && typeof item.source === 'object' && !Array.isArray(item.source)
          ? item.source as Record<string, unknown>
          : null;
        const cursor = item.cursor && typeof item.cursor === 'object' && !Array.isArray(item.cursor)
          ? item.cursor as Record<string, unknown>
          : null;
        return {
          ...item,
          source: source ? { ...source, lastError: redactDiagnosticText(source.lastError) } : source,
          cursor: cursor ? { ...cursor, lastError: redactDiagnosticText(cursor.lastError) } : cursor,
        };
      }),
    };
  }

  if (path === '/ai-providers') {
    const providers = Array.isArray(obj.providers) ? obj.providers : [];
    const anomalies = Array.isArray(obj.anomalies) ? obj.anomalies : [];
    return {
      ...obj,
      providers: providers.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const item = row as Record<string, unknown>;
        return { ...item, lastError: redactDiagnosticText(item.lastError) };
      }),
      anomalies: anomalies.map(row => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
        const item = row as Record<string, unknown>;
        return { ...item, details: redactAuditDetails(item.details) };
      }),
    };
  }

  return body;
}

// Read-only Diagnoseantworten muessen denselben Secret-Redaction-Vertrag wie
// der DEV-Realtime-Transport einhalten. Der Adapter liegt absichtlich vor dem
// Legacy-Statusrouter, damit bestehende Endpunkte ohne API-Bruch gehaertet sind.
devDiagnosticsContractRouter.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => originalJson(hardenPassThroughPayload(req.path, body))) as typeof res.json;
  next();
});

// Diese Legacy-Pass-Through-Endpunkte liefern ausschliesslich globale Runtime-
// Daten. requireDev muss vor dem Scope-Guard laufen, damit kein ungepruefter
// Session-Hint als Autoritaet dient. Bei globaler DevSession faellt die Route
// unveraendert in den bestehenden devStatusRouter durch.
for (const path of ['/system', '/ai-providers'] as const) {
  devDiagnosticsContractRouter.get(path, requireDev, (req, res, next) => {
    if (rejectGlobalOnlyForRestrictedSession(req, res)) return;
    next();
  });
}

interface TimedResult<T> {
  value: T | null;
  ms: number;
  error: string | null;
}

async function timed<T>(fn: () => Promise<T>): Promise<TimedResult<T>> {
  const startedAt = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - startedAt, error: null };
  } catch (error) {
    return { value: null, ms: Date.now() - startedAt, error: redactDiagnosticText((error as Error).message) };
  }
}

// Kanonischer DB-Diagnosevertrag: Teilausfaelle werden sichtbar als degraded
// markiert. Insbesondere darf eine fehlgeschlagene Migration-Abfrage niemals
// still wie "0 Migrationen" aussehen.
devDiagnosticsContractRouter.get('/database', requireDev, async (req, res) => {
  if (rejectGlobalOnlyForRestrictedSession(req, res)) return;

  const ping = await timed(async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok');
    return rows[0]?.ok === 1;
  });
  const tables = await timed(() => prisma.$queryRawUnsafe<Array<{ relname: string; n_live_tup: bigint; n_dead_tup: bigint }>>(`
    SELECT relname, n_live_tup, n_dead_tup
    FROM pg_stat_user_tables
    ORDER BY n_live_tup DESC
    LIMIT 25
  `));
  const dbSize = await timed(async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ size: string; bytes: bigint }>>(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
             pg_database_size(current_database()) AS bytes
    `);
    return rows[0] ?? null;
  });
  const conns = await timed(() => prisma.$queryRawUnsafe<Array<{ state: string | null; count: bigint }>>(`
    SELECT state, count(*)::bigint AS count
    FROM pg_stat_activity
    WHERE datname = current_database()
    GROUP BY state
  `));
  const migrations = await timed(async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
      SELECT count(*)::bigint AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL
    `);
    return Number(rows[0]?.count ?? 0);
  });

  const errors = {
    ping: ping.error,
    tables: tables.error,
    size: dbSize.error,
    connections: conns.error,
    migrations: migrations.error,
  };
  const degraded = Object.values(errors).some(Boolean);

  res.json({
    ok: ping.value === true,
    degraded,
    pingMs: ping.ms,
    pingError: ping.error,
    sizePretty: dbSize.value?.size ?? null,
    sizeBytes: dbSize.value ? Number(dbSize.value.bytes) : null,
    migrationsApplied: migrations.value,
    connections: (conns.value ?? []).map(row => ({ state: row.state, count: Number(row.count) })),
    topTables: (tables.value ?? []).map(row => ({
      name: row.relname,
      liveRows: Number(row.n_live_tup),
      deadRows: Number(row.n_dead_tup),
    })),
    errors,
    generatedAt: new Date().toISOString(),
  });
});

// Offline/noch nicht gebundener Discord-Client liefert denselben vollstaendigen
// Shape wie der Online-Pfad. Die UI darf bei einem Diagnosefehler nicht durch
// fehlende Arrays/Objekte selbst crashen.
devDiagnosticsContractRouter.get('/discord', requireDev, (req, res) => {
  if (rejectGlobalOnlyForRestrictedSession(req, res)) return;

  const client = tryGetDashboardClient();
  if (!client) {
    res.json({
      ok: false,
      error: 'Discord-Client nicht gebunden.',
      statusCode: null,
      averagePingMs: null,
      shards: [],
      cache: { guilds: 0, users: 0, channels: 0 },
      user: null,
      generatedAt: new Date().toISOString(),
    });
    return;
  }

  const statusCode = client.ws.status;
  res.json({
    ok: statusCode === 0,
    error: null,
    statusCode,
    averagePingMs: client.ws.ping,
    shards: Array.from(client.ws.shards.values()).map(shard => ({
      id: shard.id,
      status: shard.status,
      pingMs: shard.ping,
    })),
    cache: {
      guilds: client.guilds.cache.size,
      users: client.users.cache.size,
      channels: client.channels.cache.size,
    },
    user: client.user ? { id: client.user.id, tag: client.user.tag } : null,
    generatedAt: new Date().toISOString(),
  });
});

// Der Retrieval-Debugger ist ein Guild-Datenread. Er muss deshalb exakt an den
// optionalen DevSession-Guild-Scope gebunden und ohne String/Number-Coercion
// validiert werden.
devDiagnosticsContractRouter.post('/ai-retrieval-debug', requireDev, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({ error: 'Ungueltiger Request-Body.' });
    return;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.guildId !== 'string' || !/^\d{17,20}$/.test(record.guildId.trim())) {
    res.status(400).json({ error: 'Ungueltige guildId.' });
    return;
  }
  if (typeof record.question !== 'string') {
    res.status(400).json({ error: 'Ungueltige Frage.' });
    return;
  }
  const guildId = record.guildId.trim();
  const question = record.question.trim();
  if (question.length < 2 || question.length > 4000) {
    res.status(400).json({ error: 'Frage muss 2 bis 4000 Zeichen lang sein.' });
    return;
  }

  let limit = 3;
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > 10) {
      res.status(400).json({ error: 'limit muss eine Ganzzahl zwischen 1 und 10 sein.' });
      return;
    }
    limit = record.limit;
  }

  const restrict = req.devSession?.scope.guildIdRestrict ?? null;
  if (restrict && restrict !== guildId) {
    res.status(403).json({
      error: 'DEV-Session ist auf eine andere Guild beschraenkt.',
      code: 'DEV_SCOPE_RESTRICTED',
    });
    return;
  }

  try {
    const { debugRetrieval } = await import('../../../modules/ai/guildKnowledge.js');
    const { getPromptBudgets } = await import('../../../modules/ai/promptBudget.js');
    const result = await debugRetrieval(guildId, question, limit);
    res.json({ ...result, promptBudgets: getPromptBudgets() });
  } catch (error) {
    logger.error('[DEV-Status] ai-retrieval-debug failed', error as Error);
    res.status(500).json({ error: 'Retrieval-Debug fehlgeschlagen.' });
  }
});
