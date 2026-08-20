process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockAuditFindMany = jest.fn();
const mockPrismaSnapshot = jest.fn();
const mockAiSnapshot = jest.fn();
const mockQueryLogRing = jest.fn();
const mockReadBackupStatus = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: {
      findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args),
      updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args),
    },
    auditLog: {
      findMany: (...args: unknown[]) => mockAuditFindMany(...args),
    },
  },
}));

jest.mock('../../src/dashboard/services/observability', () => ({
  __esModule: true,
  getPrismaSnapshot: (...args: unknown[]) => mockPrismaSnapshot(...args),
  getAiSnapshot: (...args: unknown[]) => mockAiSnapshot(...args),
  queryLogRing: (...args: unknown[]) => mockQueryLogRing(...args),
  readBackupStatus: (...args: unknown[]) => mockReadBackupStatus(...args),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth } from '../../src/dashboard/middleware/auth';
import { devObservabilityRouter } from '../../src/dashboard/routes/v2/devObservability';

const RESTRICTED_GUILD = '111111111111111111';

function activeSession(scope: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'dev-session-2e',
    userDiscordId: '123456789012345678',
    scope,
    createdAt: new Date(now - 60_000),
    expiresAt: new Date(now + 60 * 60 * 1000),
  };
}

function appFor(scope: Record<string, unknown> = {}) {
  mockDevSessionFindFirst.mockResolvedValue(activeSession(scope));
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use((req, _res, next) => {
    Object.assign(req.session, {
      userId: 'u1',
      discordId: '123456789012345678',
      role: 'DEVELOPER',
    });
    next();
  });
  app.use('/api/v2', requireAuth);
  app.use('/api/v2/dev/observability', devObservabilityRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockPrismaSnapshot.mockReturnValue([]);
  mockAiSnapshot.mockReturnValue([]);
  mockQueryLogRing.mockReturnValue([]);
  mockReadBackupStatus.mockResolvedValue({
    dir: '/tmp/backup', exists: true, count: 0, newest: null, oldest: null, totalBytes: 0, entries: [],
  });
  mockAuditFindMany.mockResolvedValue([]);
});

describe('Dashboard-2E DEV observability contract', () => {
  it.each([
    '/metrics/prisma',
    '/metrics/ai',
    '/logs?n=10',
    '/backup/status',
    '/audit/search?limit=10',
  ])('sperrt globalen Observability-Endpunkt %s in guildIdRestrict', async path => {
    const response = await request(appFor({ guildIdRestrict: RESTRICTED_GUILD }))
      .get(`/api/v2/dev/observability${path}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
  });

  it('blockiert restricted Sessions vor globalen Service-/DB-Reads', async () => {
    const app = appFor({ guildIdRestrict: RESTRICTED_GUILD });
    await request(app).get('/api/v2/dev/observability/metrics/prisma');
    await request(app).get('/api/v2/dev/observability/metrics/ai');
    await request(app).get('/api/v2/dev/observability/logs');
    await request(app).get('/api/v2/dev/observability/backup/status');
    await request(app).get('/api/v2/dev/observability/audit/search');

    expect(mockPrismaSnapshot).not.toHaveBeenCalled();
    expect(mockAiSnapshot).not.toHaveBeenCalled();
    expect(mockQueryLogRing).not.toHaveBeenCalled();
    expect(mockReadBackupStatus).not.toHaveBeenCalled();
    expect(mockAuditFindMany).not.toHaveBeenCalled();
  });

  it('laesst globale DevSessions weiterhin Observability lesen', async () => {
    mockPrismaSnapshot.mockReturnValue([{ key: 'User:findMany', count: 1 }]);
    const response = await request(appFor()).get('/api/v2/dev/observability/metrics/prisma');

    expect(response.status).toBe(200);
    expect(response.body.buckets).toEqual([{ key: 'User:findMany', count: 1 }]);
  });

  it('redigiert Live-Log message und serialisierte meta vor der Response', async () => {
    mockQueryLogRing.mockReturnValue([{
      ts: 123,
      level: 'error',
      message: 'Authorization: Bearer very.secret.token',
      meta: JSON.stringify({ token: 'super-secret', cookie: 'session-cookie', nested: { password: 'pw-123' } }),
    }]);

    const response = await request(appFor()).get('/api/v2/dev/observability/logs?n=20');

    expect(response.status).toBe(200);
    const serialized = JSON.stringify(response.body);
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).not.toContain('very.secret.token');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('session-cookie');
    expect(serialized).not.toContain('pw-123');
  });

  it.each([
    '/logs?n=0',
    '/logs?n=501',
    '/logs?n=01',
    '/logs?since=abc',
    '/logs?level=TRACE',
    '/audit/search?q=x',
    '/audit/search?guildId=abc',
    '/audit/search?actorId=%20bad',
    '/audit/search?before=2026-08-20T00:00:00.000Z',
    '/audit/search?cursor=broken',
    '/audit/search?q=alpha&action=beta',
  ])('weist malformed/coercing Query fail-closed ab: %s', async path => {
    const response = await request(appFor()).get(`/api/v2/dev/observability${path}`);
    expect(response.status).toBe(400);
  });

  it('paginiert globale Audit-Suche verlustfrei per createdAt+id und redigiert Legacy-Details', async () => {
    const sameTime = new Date('2026-08-20T18:00:00.000Z');
    mockAuditFindMany.mockResolvedValue([
      {
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        action: 'SECURITY_ONE',
        category: 'SECURITY',
        guildId: RESTRICTED_GUILD,
        createdAt: sameTime,
        actor: { discordId: '123456789012345678', username: 'actor' },
        target: null,
        channelId: null,
        ipAddress: '127.0.0.1',
        details: { token: 'legacy-secret', note: 'Authorization: Bearer raw-token' },
      },
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        action: 'SECURITY_TWO',
        category: 'SECURITY',
        guildId: RESTRICTED_GUILD,
        createdAt: sameTime,
        actor: null,
        target: null,
        channelId: null,
        ipAddress: null,
        details: { ok: true },
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        action: 'SECURITY_THREE',
        category: 'SECURITY',
        guildId: RESTRICTED_GUILD,
        createdAt: new Date('2026-08-20T17:59:59.000Z'),
        actor: null,
        target: null,
        channelId: null,
        ipAddress: null,
        details: null,
      },
    ]);

    const response = await request(appFor()).get('/api/v2/dev/observability/audit/search?limit=2&q=SECURITY');

    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(2);
    expect(response.body.hasMore).toBe(true);
    expect(response.body.nextCursor).toMatch(/^v1\./);
    expect(response.body.entries[0].details.token).toBe('[REDACTED]');
    expect(JSON.stringify(response.body.entries[0].details)).not.toContain('raw-token');
    expect(mockAuditFindMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 3,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
  });
});
