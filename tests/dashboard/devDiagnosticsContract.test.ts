process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockSessionFindUnique = jest.fn();
const mockRaw = jest.fn();
const mockGetStats = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    session: { findUnique: (...args: unknown[]) => mockSessionFindUnique(...args) },
    devSession: {
      findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args),
      updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args),
    },
    $queryRawUnsafe: (...args: unknown[]) => mockRaw(...args),
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: jest.fn().mockReturnValue(null),
  getDashboardClient: jest.fn(),
  setDashboardClient: jest.fn(),
}));

jest.mock('../../src/modules/ai/providerStats', () => ({
  __esModule: true,
  getProviderConfigurationHealth: jest.fn(() => ({
    primary: 'groq', primaryConfigured: false,
    configuredProviders: [], fallbackProviders: [],
    configuredCount: 0, resilience: 'unavailable',
    warnings: ['Kein AI-Provider-API-Key konfiguriert.'],
  })),
  getStats: (...args: unknown[]) => mockGetStats(...args),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth } from '../../src/dashboard/middleware/auth';
import { devDiagnosticsContractRouter } from '../../src/dashboard/routes/v2/devDiagnosticsContract';
import { devStatusRouter } from '../../src/dashboard/routes/v2/devStatus';

const SESSION_TOKEN = 'stage36-dev-diagnostics-session-token';

function activeSession(scope: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'dev-session-1',
    userDiscordId: '123456789012345678',
    scope,
    createdAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60 * 1000),
  };
}

function makeApp(scope: Record<string, unknown> = {}) {
  mockSessionFindUnique.mockResolvedValue({
    isActive: true,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    userId: 'u1',
  });
  mockDevSessionFindFirst.mockResolvedValue(activeSession(scope));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    Object.assign(req.session, {
      userId: 'u1',
      discordId: '123456789012345678',
      role: 'DEVELOPER',
      sessionToken: SESSION_TOKEN,
    });
    next();
  });
  app.use('/api/v2', requireAuth);
  app.use('/api/v2/dev/status', devDiagnosticsContractRouter, devStatusRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockRaw.mockImplementation((sql: string) => {
    if (sql.includes('SELECT 1')) return Promise.resolve([{ ok: 1 }]);
    if (sql.includes('pg_stat_user_tables')) return Promise.resolve([{ relname: 'AuditLog', n_live_tup: BigInt(5), n_dead_tup: BigInt(1) }]);
    if (sql.includes('pg_database_size')) return Promise.resolve([{ size: '1 MB', bytes: BigInt(1_048_576) }]);
    if (sql.includes('pg_stat_activity')) return Promise.resolve([{ state: 'idle', count: BigInt(2) }]);
    if (sql.includes('_prisma_migrations')) return Promise.resolve([{ count: BigInt(42) }]);
    return Promise.resolve([]);
  });
  mockGetStats.mockResolvedValue([]);
});

describe('Dashboard-2C DEV diagnostics contract', () => {
  it('liefert bei fehlendem Discord-Client einen stabilen vollstaendigen Offline-Shape', async () => {
    const response = await request(makeApp()).get('/api/v2/dev/status/discord');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: false,
      statusCode: null,
      averagePingMs: null,
      shards: [],
      cache: { guilds: 0, users: 0, channels: 0 },
      user: null,
    });
  });

  it('markiert Migration-Queryfehler degraded statt sie als 0 Migrationen zu tarnen', async () => {
    mockRaw.mockImplementation((sql: string) => {
      if (sql.includes('SELECT 1')) return Promise.resolve([{ ok: 1 }]);
      if (sql.includes('pg_stat_user_tables')) return Promise.resolve([]);
      if (sql.includes('pg_database_size')) return Promise.resolve([{ size: '1 MB', bytes: BigInt(1_048_576) }]);
      if (sql.includes('pg_stat_activity')) return Promise.resolve([]);
      if (sql.includes('_prisma_migrations')) return Promise.reject(new Error('password=hunter2 migration failed'));
      return Promise.resolve([]);
    });

    const response = await request(makeApp()).get('/api/v2/dev/status/database');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.degraded).toBe(true);
    expect(response.body.migrationsApplied).toBeNull();
    expect(response.body.errors.migrations).toContain('[REDACTED]');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
  });

  it('redigiert Provider-Fehler auch auf Legacy-Pass-Through-Endpunkten', async () => {
    mockGetStats.mockResolvedValue([
      {
        provider: 'test-provider',
        configured: true,
        successCount: 0,
        failureCount: 2,
        rateLimitCount: 0,
        avgLatencyMs: 10,
        successRate: 0,
        lastSuccessAt: null,
        lastFailureAt: new Date(),
        lastError: 'Authorization: Bearer super-secret-token',
      },
    ]);

    const response = await request(makeApp()).get('/api/v2/dev/status/ai-providers');
    expect(response.status).toBe(200);
    const dump = JSON.stringify(response.body);
    expect(dump).toContain('[REDACTED]');
    expect(dump).not.toContain('super-secret-token');
  });

  it('blockiert AI-Retrieval-Debug ausserhalb des guildIdRestrict vor dem Datenread', async () => {
    const response = await request(makeApp({ guildIdRestrict: '111111111111111111' }))
      .post('/api/v2/dev/status/ai-retrieval-debug')
      .send({ guildId: '222222222222222222', question: 'Was ist aktiv?', limit: 3 });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
  });

  it.each([
    { guildId: ['111111111111111111'], question: 'ok', limit: 3 },
    { guildId: '111111111111111111', question: true, limit: 3 },
    { guildId: '111111111111111111', question: 'ok', limit: '3' },
    { guildId: '111111111111111111', question: 'ok', limit: 0 },
    { guildId: '111111111111111111', question: 'ok', limit: 11 },
  ])('weist coercible/malformed Retrieval-Debug-Payloads fail-closed ab: %p', async payload => {
    const response = await request(makeApp()).post('/api/v2/dev/status/ai-retrieval-debug').send(payload);
    expect(response.status).toBe(400);
  });
});
