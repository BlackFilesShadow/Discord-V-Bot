process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.ENCRYPTION_KEY ||= 'test-encryption-key-0123456789abcdef';

const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const mockConnectionFindMany = jest.fn();
const mockConnectionFindFirst = jest.fn();
const mockSnapshotFindFirst = jest.fn();
const mockStartSnapshot = jest.fn();
const mockGetSnapshotProgress = jest.fn();
const mockListSnapshots = jest.fn();
const mockGetSettings = jest.fn();
const mockListFiles = jest.fn();
const mockFindFiles = jest.fn();
const mockGetFile = jest.fn();
const mockStepUp = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: {
      findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args),
      updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args),
    },
    nitradoConnection: {
      findMany: (...args: unknown[]) => mockConnectionFindMany(...args),
      findFirst: (...args: unknown[]) => mockConnectionFindFirst(...args),
    },
    nitradoSnapshot: {
      findFirst: (...args: unknown[]) => mockSnapshotFindFirst(...args),
    },
  },
}));

jest.mock('../../src/dashboard/middleware/devStepUp', () => ({
  requireVerifiedDevMutationStepUp: (req: any, res: any, next: any) => {
    mockStepUp(req.body);
    if (!req.body?.reason || !req.body?.reAuth) {
      res.status(403).json({ error: 'step_up_required' });
      return;
    }
    next();
  },
}));

jest.mock('../../src/modules/nitrado/mirror/snapshotService', () => ({
  startSnapshot: (...args: unknown[]) => mockStartSnapshot(...args),
  getSnapshotProgress: (...args: unknown[]) => mockGetSnapshotProgress(...args),
}));

jest.mock('../../src/modules/nitrado/mirror/queryApi', () => ({
  listSnapshots: (...args: unknown[]) => mockListSnapshots(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  findFiles: (...args: unknown[]) => mockFindFiles(...args),
  getFile: (...args: unknown[]) => mockGetFile(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { requireAuth } from '../../src/dashboard/middleware/auth';
import { devNitradoMirrorRouter } from '../../src/dashboard/routes/v2/devNitradoMirror';

const RESTRICTED_GUILD = '111111111111111111';
const OTHER_GUILD = '222222222222222222';
const CONN_ID = 'conn_123';
const SNAPSHOT_ID = 'snapshot_123';

function activeSession(scope: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: 'dev-session-2f',
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
  app.use('/api/v2/dev/nitrado-mirror', devNitradoMirrorRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDevSessionUpdateMany.mockResolvedValue({ count: 0 });
  mockConnectionFindMany.mockResolvedValue([]);
  mockConnectionFindFirst.mockResolvedValue({ id: CONN_ID });
  mockSnapshotFindFirst.mockResolvedValue({ id: SNAPSHOT_ID });
  mockStartSnapshot.mockResolvedValue({ snapshotId: SNAPSHOT_ID });
  mockGetSnapshotProgress.mockResolvedValue({
    id: SNAPSHOT_ID,
    status: 'OK',
    totalBytes: BigInt(100),
    storedBytes: BigInt(100),
  });
  mockListSnapshots.mockResolvedValue([]);
  mockGetSettings.mockResolvedValue({ id: SNAPSHOT_ID });
  mockListFiles.mockResolvedValue([]);
  mockFindFiles.mockResolvedValue([]);
  mockGetFile.mockResolvedValue(null);
});

describe('Dashboard-2F DEV Nitrado Mirror contract', () => {
  it('filtert /connections serverseitig auf guildIdRestrict', async () => {
    const response = await request(appFor({ guildIdRestrict: RESTRICTED_GUILD }))
      .get('/api/v2/dev/nitrado-mirror/connections');

    expect(response.status).toBe(200);
    expect(mockConnectionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { guildId: RESTRICTED_GUILD },
    }));
  });

  it.each([
    `/progress/${SNAPSHOT_ID}?guildId=${OTHER_GUILD}`,
    `/snapshots?guildId=${OTHER_GUILD}&connId=${CONN_ID}`,
    `/${SNAPSHOT_ID}/settings?guildId=${OTHER_GUILD}`,
    `/${SNAPSHOT_ID}/files?guildId=${OTHER_GUILD}&dir=%2F`,
    `/${SNAPSHOT_ID}/find?guildId=${OTHER_GUILD}&q=types`,
    `/${SNAPSHOT_ID}/file?guildId=${OTHER_GUILD}&path=%2Ftypes.xml`,
  ])('weist cross-guild read in restricted Session vor Datenzugriff ab: %s', async path => {
    const response = await request(appFor({ guildIdRestrict: RESTRICTED_GUILD }))
      .get(`/api/v2/dev/nitrado-mirror${path}`);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    expect(mockSnapshotFindFirst).not.toHaveBeenCalled();
    expect(mockConnectionFindFirst).not.toHaveBeenCalled();
    expect(mockGetSnapshotProgress).not.toHaveBeenCalled();
  });

  it('verlangt Step-Up fuer Snapshot-Trigger und startet ohne Credential keinen Snapshot', async () => {
    const response = await request(appFor())
      .post('/api/v2/dev/nitrado-mirror/trigger')
      .send({ guildId: RESTRICTED_GUILD, connId: CONN_ID });

    expect(response.status).toBe(403);
    expect(mockStepUp).toHaveBeenCalledTimes(1);
    expect(mockStartSnapshot).not.toHaveBeenCalled();
  });

  it('weist restricted cross-guild Trigger nach Step-Up vor Nitrado/DB-Side-Effect ab', async () => {
    const response = await request(appFor({ guildIdRestrict: RESTRICTED_GUILD }))
      .post('/api/v2/dev/nitrado-mirror/trigger')
      .send({ guildId: OTHER_GUILD, connId: CONN_ID, reason: 'diagnose snapshot', reAuth: '123456' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('DEV_SCOPE_RESTRICTED');
    expect(mockConnectionFindFirst).not.toHaveBeenCalled();
    expect(mockStartSnapshot).not.toHaveBeenCalled();
  });

  it('bindet connId vor Trigger explizit an die angeforderte Guild', async () => {
    mockConnectionFindFirst.mockResolvedValue(null);
    const response = await request(appFor())
      .post('/api/v2/dev/nitrado-mirror/trigger')
      .send({ guildId: RESTRICTED_GUILD, connId: CONN_ID, reason: 'diagnose snapshot', reAuth: '123456' });

    expect(response.status).toBe(404);
    expect(mockConnectionFindFirst).toHaveBeenCalledWith({
      where: { id: CONN_ID, guildId: RESTRICTED_GUILD },
      select: { id: true },
    });
    expect(mockStartSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    '/snapshots?guildId=111&connId=conn_123',
    `/snapshots?guildId=${RESTRICTED_GUILD}&connId=%20conn_123`,
    `/snapshots?guildId=${RESTRICTED_GUILD}&connId=bad%2Fid`,
    `/${SNAPSHOT_ID}/files?guildId=${RESTRICTED_GUILD}&dir=relative`,
    `/${SNAPSHOT_ID}/files?guildId=${RESTRICTED_GUILD}&dir=%2F..%2Fsecret`,
    `/${SNAPSHOT_ID}/find?guildId=${RESTRICTED_GUILD}&q=x`,
  ])('weist malformed/coercing Input fail-closed ab: %s', async path => {
    const response = await request(appFor()).get(`/api/v2/dev/nitrado-mirror${path}`);
    expect(response.status).toBe(400);
  });

  it('erlaubt gueltigen scoped Read und serialisiert BigInt-Felder', async () => {
    const response = await request(appFor({ guildIdRestrict: RESTRICTED_GUILD }))
      .get(`/api/v2/dev/nitrado-mirror/progress/${SNAPSHOT_ID}?guildId=${RESTRICTED_GUILD}`);

    expect(response.status).toBe(200);
    expect(response.body.totalBytes).toBe('100');
    expect(response.body.storedBytes).toBe('100');
    expect(mockGetSnapshotProgress).toHaveBeenCalledWith(SNAPSHOT_ID, RESTRICTED_GUILD);
  });
});
