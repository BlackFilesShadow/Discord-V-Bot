process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireDev: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../src/dashboard/middleware/devSecurity', () => ({
  logDevAction: jest.fn(),
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(),
    user: { count: jest.fn() },
    package: { count: jest.fn() },
    upload: { count: jest.fn() },
  },
}));

import express from 'express';
import request from 'supertest';
import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { devCommandCenterRouter } from '../../src/dashboard/routes/v2/devCommandCenter';

const queryMock = prisma.$queryRaw as jest.Mock;
const userCountMock = prisma.user.count as jest.Mock;
const packageCountMock = prisma.package.count as jest.Mock;
const uploadCountMock = prisma.upload.count as jest.Mock;
const clientMock = tryGetDashboardClient as jest.MockedFunction<typeof tryGetDashboardClient>;

function app() {
  const instance = express();
  instance.use(devCommandCenterRouter);
  return instance;
}

function installClient() {
  clientMock.mockReturnValue({
    ws: { ping: 42 },
    uptime: 123_456,
    guilds: { cache: new Map([['guild', {}]]) },
    users: { cache: new Map([['user', {}]]) },
    channels: { cache: new Map([['channel', {}]]) },
  } as never);
}

describe('DEV diagnostics resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    installClient();
    queryMock.mockResolvedValue([{ '?column?': 1 }]);
    userCountMock.mockResolvedValue(10);
    packageCountMock.mockResolvedValue(20);
    uploadCountMock.mockResolvedValue(30);
  });

  it('liefert normalen DB-Status und Counts wenn PostgreSQL erreichbar ist', async () => {
    const res = await request(app()).get('/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({ ok: true, users: 10, packages: 20, uploads: 30 });
    expect(res.body.bot).toMatchObject({ ready: true, websocketPingMs: 42, uptimeMs: 123456 });
    expect(res.body.system).toEqual(expect.objectContaining({ node: process.version }));
    expect(res.body.process).toEqual(expect.objectContaining({ heapUsed: expect.any(Number) }));
  });

  it('liefert System-/Bot-Diagnostik weiter und markiert DB-Counts null wenn der DB-Ping scheitert', async () => {
    queryMock.mockRejectedValueOnce(new Error('postgres unavailable'));

    const res = await request(app()).get('/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({ ok: false, users: null, packages: null, uploads: null });
    expect(res.body.bot).toMatchObject({ ready: true, websocketPingMs: 42, uptimeMs: 123456 });
    expect(res.body.system).toEqual(expect.objectContaining({ os: expect.any(String), cpuCount: expect.any(Number) }));
    expect(res.body.process).toEqual(expect.objectContaining({ rss: expect.any(Number) }));
    expect(userCountMock).not.toHaveBeenCalled();
  });

  it('faellt ebenfalls graceful zurueck wenn ein Count nach erfolgreichem Ping scheitert', async () => {
    packageCountMock.mockRejectedValueOnce(new Error('count failed'));

    const res = await request(app()).get('/diagnostics');
    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({ ok: false, users: null, packages: null, uploads: null });
    expect(res.body.bot.ready).toBe(true);
    expect(res.body.generatedAt).toEqual(expect.any(String));
  });
});
