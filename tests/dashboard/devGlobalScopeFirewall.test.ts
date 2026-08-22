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
const mockTryGetDashboardClient = jest.fn();

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
  tryGetDashboardClient: (...args: unknown[]) => mockTryGetDashboardClient(...args),
  getDashboardClient: jest.fn(),
  setDashboardClient: jest.fn(),
}));

jest.mock('../../src/dashboard/services/observability', () => ({
  __esModule: true,
  queryLogRing: jest.fn().mockReturnValue([]),
}));

jest.mock('../../src/utils/metrics', () => ({
  __esModule: true,
  errorCounter: { get: jest.fn().mockResolvedValue({ values: [] }) },
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth, requireDev } from '../../src/dashboard/middleware/auth';
import { devDiagnosticsContractRouter } from '../../src/dashboard/routes/v2/devDiagnosticsContract';
import { devDiagnosticsStubsRouter } from '../../src/dashboard/routes/v2/devDiagnosticsStubs';

const RESTRICTED_GUILD = '111111111111111111';
const SESSION_TOKEN = 'stage36-dev-global-scope-session-token';

function activeSession(scope: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'dev-session-2d',
    userDiscordId: '123456789012345678',
    scope,
    createdAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60 * 1000),
  };
}

function baseApp(scope: Record<string, unknown> = {}) {
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
  return app;
}

function statusApp(scope: Record<string, unknown> = {}) {
  const app = baseApp(scope);
  app.use('/api/v2/dev/status', devDiagnosticsContractRouter);
  app.get('/api/v2/dev/status/system', (_req, res) => res.json({ legacy: 'system' }));
  app.get('/api/v2/dev/status/ai-providers', (_req, res) => res.json({ legacy: 'ai-providers' }));
  return app;
}

function stubsApp(scope: Record<string, unknown> = {}) {
  const app = baseApp(scope);
  app.use('/api/v2/dev/stubs', requireDev, devDiagnosticsStubsRouter);
  app.get('/api/v2/dev/stubs/server-stats', (_req, res) => res.json({ legacy: 'server-stats' }));
  app.get('/api/v2/dev/stubs/debug', (_req, res) => res.json({ legacy: 'debug' }));
  app.get('/api/v2/dev/stubs/commands', (_req, res) => res.json({ legacy: 'commands' }));
  app.post('/api/v2/dev/stubs/debug/heap-snapshot', (_req, res) => res.json({ legacy: 'heap-snapshot' }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockTryGetDashboardClient.mockReturnValue(null);
  mockRaw.mockResolvedValue([]);
});

describe('Dashboard-2D DEV global-scope firewall', () => {
  it.each(['/database', '/discord', '/system', '/ai-providers'])(
    'sperrt globalen Status-Endpunkt %s in guildIdRestrict',
    async path => {
      const response = await request(statusApp({ guildIdRestrict: RESTRICTED_GUILD }))
        .get(`/api/v2/dev/status${path}`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    },
  );

  it('blockiert die DB-Diagnose vor dem ersten globalen Datenread', async () => {
    const response = await request(statusApp({ guildIdRestrict: RESTRICTED_GUILD }))
      .get('/api/v2/dev/status/database');

    expect(response.status).toBe(403);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  it('blockiert den Discord-Status vor dem globalen Client-Read', async () => {
    const response = await request(statusApp({ guildIdRestrict: RESTRICTED_GUILD }))
      .get('/api/v2/dev/status/discord');

    expect(response.status).toBe(403);
    expect(mockTryGetDashboardClient).not.toHaveBeenCalled();
  });

  it.each(['/server-stats', '/debug', '/commands'])(
    'sperrt globalen Stub-Read %s in guildIdRestrict vor Legacy-Fallthrough',
    async path => {
      const response = await request(stubsApp({ guildIdRestrict: RESTRICTED_GUILD }))
        .get(`/api/v2/dev/stubs${path}`);

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
      expect(response.body.legacy).toBeUndefined();
    },
  );

  it('sperrt auch die globale Heap-Snapshot-Mutation vor dem Legacy-Handler', async () => {
    const response = await request(stubsApp({ guildIdRestrict: RESTRICTED_GUILD }))
      .post('/api/v2/dev/stubs/debug/heap-snapshot')
      .send({ reason: 'test', reAuth: 'test' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    expect(response.body.legacy).toBeUndefined();
  });

  it('laesst globale DevSessions unveraendert in Legacy-Status und -Stubs durch', async () => {
    const system = await request(statusApp()).get('/api/v2/dev/status/system');
    expect(system.status).toBe(200);
    expect(system.body).toEqual({ legacy: 'system' });

    const serverStats = await request(stubsApp()).get('/api/v2/dev/stubs/server-stats');
    expect(serverStats.status).toBe(200);
    expect(serverStats.body).toEqual({ legacy: 'server-stats' });
  });
});
