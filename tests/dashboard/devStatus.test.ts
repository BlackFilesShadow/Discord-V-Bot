/**
 * Smoke + Pen-Tests fuer /api/v2/dev/status/* (Phase 3).
 *
 * Verifiziert die DREI Auth-Gates der DEV-Konsole:
 *   1. requireAuth         — kein Login -> 401
 *   2. role===DEVELOPER    -> sonst 403
 *   3. aktive DevSession   -> sonst 403 (DEV_LOGIN_REQUIRED)
 *
 * Plus: Endpunkte liefern keine Secrets und der system-Endpoint funktioniert
 * out-of-process ohne Discord-Client.
 */

process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

const mockDevSessionFindFirst = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: { findFirst: (...a: unknown[]) => mockDevSessionFindFirst(...a) },
    twoFactorAuth: { findUnique: jest.fn().mockResolvedValue({ isEnabled: true }) },
    ipList: { count: jest.fn().mockResolvedValue(1), findFirst: jest.fn().mockResolvedValue({ id: 'allow1' }) },
    securityEvent: { create: jest.fn().mockResolvedValue({}) },
    nitradoJob: {
      groupBy: jest.fn().mockResolvedValue([
        { status: 'PENDING', _count: { _all: 2 } },
        { status: 'DONE', _count: { _all: 100 } },
      ]),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    aiProviderStat: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRawUnsafe: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('SELECT 1')) return Promise.resolve([{ ok: 1 }]);
      if (sql.includes('pg_database_size')) return Promise.resolve([{ size: '12 MB', bytes: BigInt(12_582_912) }]);
      if (sql.includes('pg_stat_user_tables')) return Promise.resolve([{ relname: 'AuditLog', n_live_tup: BigInt(5000), n_dead_tup: BigInt(123) }]);
      if (sql.includes('pg_stat_activity')) return Promise.resolve([{ state: 'idle', count: BigInt(3) }]);
      if (sql.includes('_prisma_migrations')) return Promise.resolve([{ count: BigInt(42) }]);
      return Promise.resolve([]);
    }),
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  setDashboardClient: jest.fn(),
  getDashboardClient: jest.fn(),
  tryGetDashboardClient: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/modules/ai/providerStats', () => ({
  __esModule: true,
  getStats: jest.fn().mockResolvedValue([
    {
      provider: 'groq', configured: true,
      successCount: 100, failureCount: 50, rateLimitCount: 5,
      avgLatencyMs: 1200, successRate: 0.6452,
      lastSuccessAt: new Date(), lastFailureAt: new Date(),
      lastError: 'mocked-error',
    },
    {
      provider: 'cerebras', configured: false,
      successCount: 0, failureCount: 0, rateLimitCount: 0,
      avgLatencyMs: 0, successRate: 0,
      lastSuccessAt: null, lastFailureAt: null, lastError: null,
    },
  ]),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { devStatusRouter } from '../../src/dashboard/routes/v2/devStatus';
import { requireAuth } from '../../src/dashboard/middleware/auth';

function makeApp(sessionData?: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 't', resave: false, saveUninitialized: true }));
  if (sessionData) {
    app.use((req, _res, next) => { Object.assign(req.session, sessionData); next(); });
  }
  app.use('/api/v2', requireAuth);
  app.use('/api/v2/dev/status', devStatusRouter);
  // Surfaced 500-Stack fuer Test-Diagnose.
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    console.error('[TEST 500]', err.message, err.stack);
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => mockDevSessionFindFirst.mockReset());

describe('/api/v2/dev/status — Auth-Gates (Defense-in-depth)', () => {
  it('Gate 1: kein Login -> 401', async () => {
    const r = await request(makeApp()).get('/api/v2/dev/status/system');
    expect(r.status).toBe(401);
  });

  it('Gate 2: eingeloggt aber role!=DEVELOPER -> 403', async () => {
    const app = makeApp({ userId: 'u1', discordId: '123456789012345678', role: 'USER' });
    const r = await request(app).get('/api/v2/dev/status/system');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/DEVELOPER/);
  });

  it('Gate 3: DEVELOPER ohne DevSession -> 403 mit DEV_LOGIN_REQUIRED', async () => {
    mockDevSessionFindFirst.mockResolvedValue(null);
    const app = makeApp({ userId: 'u1', discordId: '123456789012345678', role: 'DEVELOPER' });
    const r = await request(app).get('/api/v2/dev/status/system');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('DEV_LOGIN_REQUIRED');
  });

  it('Alle 3 Gates erfuellt -> 200', async () => {
    mockDevSessionFindFirst.mockResolvedValue({ id: 'd1', userDiscordId: '123456789012345678' });
    const app = makeApp({ userId: 'u1', discordId: '123456789012345678', role: 'DEVELOPER' });
    const r = await request(app).get('/api/v2/dev/status/system');
    expect(r.status).toBe(200);
    expect(r.body.process.pid).toBeGreaterThan(0);
  });
});

describe('/api/v2/dev/status — Endpunkte', () => {
  beforeEach(() => mockDevSessionFindFirst.mockResolvedValue({ id: 'd1' }));

  function devApp() {
    return makeApp({ userId: 'u1', discordId: '123456789012345678', role: 'DEVELOPER' });
  }

  it('GET /database liefert pingMs/sizePretty/topTables ohne Connection-String', async () => {
    const r = await request(devApp()).get('/api/v2/dev/status/database');
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('ok', true);
    expect(r.body).toHaveProperty('sizePretty', '12 MB');
    expect(r.body).toHaveProperty('migrationsApplied', 42);
    expect(r.body.topTables[0]).toMatchObject({ name: 'AuditLog', liveRows: 5000, deadRows: 123 });
    // Pen: KEINE Secrets im Output
    const dump = JSON.stringify(r.body);
    expect(dump).not.toMatch(/postgres:\/\//i);
    expect(dump).not.toMatch(/password/i);
    expect(dump).not.toMatch(/DATABASE_URL/i);
  });

  it('GET /discord ohne Bot-Client -> ok=false (kein Crash)', async () => {
    const r = await request(devApp()).get('/api/v2/dev/status/discord');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/nicht gebunden/i);
  });

  it('GET /nitrado liefert counts aller 5 Status', async () => {
    const r = await request(devApp()).get('/api/v2/dev/status/nitrado');
    expect(r.status).toBe(200);
    expect(r.body.counts).toMatchObject({ PENDING: 2, RUNNING: 0, DONE: 100, FAILED: 0, DEAD: 0 });
  });

  it('GET /system liefert process+host+memory', async () => {
    const r = await request(devApp()).get('/api/v2/dev/status/system');
    expect(r.status).toBe(200);
    expect(r.body.process.pid).toBe(process.pid);
    expect(r.body.process.memory.rss).toBeGreaterThan(0);
    expect(r.body.host.cpuCount).toBeGreaterThan(0);
    // Pen: KEINE Tokens / Env-Variablen
    const dump = JSON.stringify(r.body);
    expect(dump).not.toMatch(/DISCORD_TOKEN/i);
    expect(dump).not.toMatch(/SESSION_SECRET/i);
  });

  it('GET /ai-providers erkennt Anomalien (high_failure_rate + no_calls)', async () => {
    const r = await request(devApp()).get('/api/v2/dev/status/ai-providers');
    expect(r.status).toBe(200);
    expect(r.body.providers).toHaveLength(2);
    // groq: 100/(100+50+5)=0.6452 -> >30% failure -> error
    // cerebras: configured=false -> kein no_calls (uebersprungen)
    const reasons = r.body.anomalies.map((a: { reason: string }) => a.reason);
    expect(reasons).toContain('high_failure_rate');
    // Pen: KEINE API-Keys
    const dump = JSON.stringify(r.body);
    expect(dump).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(dump).not.toMatch(/api[_-]?key/i);
  });
});
