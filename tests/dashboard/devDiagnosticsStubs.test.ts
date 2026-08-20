process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockNitradoGroupBy = jest.fn();
const mockNitradoFindMany = jest.fn();
const mockLinkGroupBy = jest.fn();
const mockLinkCount = jest.fn();
const mockSecurityGroupBy = jest.fn();
const mockSecurityFindMany = jest.fn();
const mockDevSessionCount = jest.fn();
const mockQueryLogRing = jest.fn();
const mockMetricGet = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: { findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args), updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args), count: (...args: unknown[]) => mockDevSessionCount(...args) },
    nitradoJob: { groupBy: (...args: unknown[]) => mockNitradoGroupBy(...args), findMany: (...args: unknown[]) => mockNitradoFindMany(...args) },
    gameIdentityLink: { groupBy: (...args: unknown[]) => mockLinkGroupBy(...args), count: (...args: unknown[]) => mockLinkCount(...args) },
    securityEvent: { groupBy: (...args: unknown[]) => mockSecurityGroupBy(...args), findMany: (...args: unknown[]) => mockSecurityFindMany(...args) },
  },
}));
jest.mock('../../src/dashboard/services/observability', () => ({ __esModule: true, queryLogRing: (...args: unknown[]) => mockQueryLogRing(...args) }));
jest.mock('../../src/utils/metrics', () => ({ __esModule: true, errorCounter: { get: (...args: unknown[]) => mockMetricGet(...args) } }));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth, requireDev } from '../../src/dashboard/middleware/auth';
import { devDiagnosticsStubsRouter } from '../../src/dashboard/routes/v2/devDiagnosticsStubs';

function activeSession(scope: Record<string, unknown> = {}) {
  const now = Date.now();
  return { id: 'dev-session-1', userDiscordId: '123456789012345678', scope, createdAt: new Date(now - 60_000), expiresAt: new Date(now + 60 * 60 * 1000) };
}

function makeApp(scope: Record<string, unknown> = {}) {
  mockDevSessionFindFirst.mockResolvedValue(activeSession(scope));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => { Object.assign(req.session, { userId: 'u1', discordId: '123456789012345678', role: 'DEVELOPER' }); next(); });
  app.use('/api/v2', requireAuth);
  app.use('/api/v2/dev/stubs', requireDev, devDiagnosticsStubsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockNitradoGroupBy.mockResolvedValue([]);
  mockNitradoFindMany.mockResolvedValue([]);
  mockLinkGroupBy.mockResolvedValue([]);
  mockLinkCount.mockResolvedValue(0);
  mockSecurityGroupBy.mockResolvedValue([]);
  mockSecurityFindMany.mockResolvedValue([]);
  mockDevSessionCount.mockResolvedValue(0);
  mockQueryLogRing.mockReturnValue([]);
  mockMetricGet.mockResolvedValue({ values: [] });
});

describe('Dashboard-2C scoped DEV stub diagnostics', () => {
  it('sperrt globale Error-Logs fuer guildIdRestrict fail-closed', async () => {
    const response = await request(makeApp({ guildIdRestrict: '111111111111111111' })).get('/api/v2/dev/stubs/errors');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    expect(mockQueryLogRing).not.toHaveBeenCalled();
    expect(mockMetricGet).not.toHaveBeenCalled();
  });

  it('redigiert globale Error-Ring-Zeilen inklusive JSON-Meta vor der Antwort', async () => {
    mockMetricGet.mockResolvedValue({ values: [{ labels: { source: 'runtime' }, value: 1 }] });
    mockQueryLogRing.mockReturnValue([{ ts: 123, level: 'error', message: 'Authorization: Bearer abc.secret.token', meta: JSON.stringify({ password: 'hunter2', nested: { token: 'secret-token' } }) }]);
    const response = await request(makeApp()).get('/api/v2/dev/stubs/errors');
    expect(response.status).toBe(200);
    const dump = JSON.stringify(response.body);
    expect(dump).toContain('[REDACTED]');
    expect(dump).not.toContain('abc.secret.token');
    expect(dump).not.toContain('hunter2');
    expect(dump).not.toContain('secret-token');
  });

  it('bindet Sync-Diagnose an guildIdRestrict und berechnet Economy-Total separat', async () => {
    const guildId = '111111111111111111';
    mockNitradoGroupBy.mockResolvedValueOnce([{ status: 'PENDING', _count: { _all: 2 } }]).mockResolvedValueOnce([{ operation: 'WHITELIST_ADD', _count: { _all: 2 } }]);
    mockNitradoFindMany.mockResolvedValue([{ id: 'job1', guildId, operation: 'WHITELIST_ADD', attempts: 2, lastError: 'token=do-not-leak', updatedAt: new Date('2026-08-20T12:00:00.000Z') }]);
    mockLinkGroupBy.mockResolvedValue([{ guildId, _count: { _all: 20 } }]);
    mockLinkCount.mockResolvedValue(42);
    const response = await request(makeApp({ guildIdRestrict: guildId })).get('/api/v2/dev/stubs/sync');
    expect(response.status).toBe(200);
    expect(response.body.scope).toEqual({ guildIdRestrict: guildId });
    expect(response.body.economyLinks.total).toBe(42);
    expect(response.body.nitrado.recentFailed[0].lastError).toContain('[REDACTED]');
    expect(JSON.stringify(response.body)).not.toContain('do-not-leak');
    for (const call of mockNitradoGroupBy.mock.calls) expect(call[0].where).toEqual({ guildId });
    expect(mockNitradoFindMany.mock.calls[0][0].where).toMatchObject({ guildId, status: 'FAILED' });
    expect(mockLinkGroupBy.mock.calls[0][0].where).toEqual({ guildId, status: 'VERIFIED' });
    expect(mockLinkCount.mock.calls[0][0].where).toEqual({ guildId, status: 'VERIFIED' });
  });

  it('sperrt globale Security-Forensik fuer guildIdRestrict', async () => {
    const response = await request(makeApp({ guildIdRestrict: '111111111111111111' })).get('/api/v2/dev/stubs/security');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    expect(mockSecurityGroupBy).not.toHaveBeenCalled();
  });
});
