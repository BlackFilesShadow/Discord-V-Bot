/**
 * Smoke + Pen-Tests fuer /api/v2/guilds/:guildId/bot-admin/* (Bot-Admin-Bereich).
 *
 * Verifiziert die Berechtigungs-Abstufung view/manage/danger, die Confirm-Pflicht
 * fuer gefaehrliche Aktionen und dass NIE Secrets ausgegeben werden
 * (insb. Feed-webhookSecret).
 */

const prismaMock = {
  appeal: {
    count: jest.fn().mockResolvedValue(3),
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
  },
  feedback: { count: jest.fn().mockResolvedValue(2) },
  upload: { count: jest.fn().mockResolvedValue(1) },
  user: {
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([{ discordId: '111111111111111111' }]),
  },
  package: {
    count: jest.fn().mockResolvedValue(4),
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 7 }),
  },
  botConfig: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  },
  auditLog: { findMany: jest.fn().mockResolvedValue([]) },
  securityEvent: { count: jest.fn().mockResolvedValue(0) },
  feed: {
    findMany: jest.fn().mockResolvedValue([
      { id: 'f1', name: 'RSS', feedType: 'RSS', url: 'https://x/y', channelId: '222222222222222222', isActive: true, webhookSecret: 'TOP-SECRET-VALUE' },
    ]),
  },
  xpConfig: { findFirst: jest.fn().mockResolvedValue({ id: 'xp1', maxLevel: 100, isActive: true }) },
  levelRole: { findMany: jest.fn().mockResolvedValue([]) },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: jest.fn().mockReturnValue(null),
  getDashboardClient: jest.fn(),
  setDashboardClient: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));

// Externe Service-Module — fuer diese Tests nicht benoetigt, aber importiert.
jest.mock('../../src/modules/registration/register', () => ({ approveManufacturer: jest.fn(), denyManufacturer: jest.fn() }));
jest.mock('../../src/utils/password', () => ({ generateOneTimePassword: jest.fn(), hashPassword: jest.fn() }));
jest.mock('../../src/utils/validator', () => ({ validateFile: jest.fn() }));
jest.mock('../../src/utils/safeSend', () => ({ safeDm: jest.fn() }));
jest.mock('../../src/modules/feeds/feedManager', () => ({ createFeed: jest.fn() }));
jest.mock('../../src/modules/selfrole/selfRoleMenu', () => ({ getMenuFull: jest.fn(), publishMenu: jest.fn() }));
jest.mock('../../src/modules/ticket/ticketManager', () => ({ closeTicket: jest.fn() }));
jest.mock('../../src/modules/ai/translator', () => ({ translate: jest.fn() }));

// Auth-Middleware: requireGuildPermission gegen einen mutierbaren Scope (mit echter hasPermission).
const mockScopeRef: { current: { isOwner: boolean; permissions: Set<string> } } = {
  current: { isOwner: false, permissions: new Set<string>() },
};

jest.mock('../../src/dashboard/middleware/auth', () => {
  const real = jest.requireActual('../../src/types/scope');
  return {
    __esModule: true,
    requireGuildPermission: (perm: string) => (req: { auth?: unknown; guildScope?: unknown }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
      const scope = {
        guildId: '999999999999999999',
        nitradoConnId: null,
        actorDiscordId: '888888888888888888',
        isOwner: mockScopeRef.current.isOwner,
        permissions: mockScopeRef.current.permissions,
      };
      if (!real.hasPermission(scope, perm)) { res.status(403).json({ error: `Permission fehlt: ${perm}` }); return; }
      req.auth = { userId: 'user-1', discordId: '888888888888888888' };
      req.guildScope = scope;
      next();
    },
  };
});

import express from 'express';
import request from 'supertest';
import { botAdminRouter } from '../../src/dashboard/routes/v2/botAdmin';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/bot-admin', botAdminRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = '/api/v2/guilds/999999999999999999/bot-admin';

function setScope(perms: string[], isOwner = false) {
  mockScopeRef.current = { isOwner, permissions: new Set(perms) };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Standard-Mock-Rueckgaben nach clearAllMocks neu setzen.
  prismaMock.appeal.count.mockResolvedValue(3);
  prismaMock.feedback.count.mockResolvedValue(2);
  prismaMock.upload.count.mockResolvedValue(1);
  prismaMock.user.count.mockResolvedValue(0);
  prismaMock.user.findMany.mockResolvedValue([{ discordId: '111111111111111111' }]);
  prismaMock.package.count.mockResolvedValue(4);
  prismaMock.package.deleteMany.mockResolvedValue({ count: 7 });
  prismaMock.botConfig.findUnique.mockResolvedValue(null);
  prismaMock.auditLog.findMany.mockResolvedValue([]);
  prismaMock.securityEvent.count.mockResolvedValue(0);
  prismaMock.appeal.findMany.mockResolvedValue([]);
  prismaMock.appeal.findUnique.mockResolvedValue(null);
  prismaMock.feed.findMany.mockResolvedValue([
    { id: 'f1', name: 'RSS', feedType: 'RSS', url: 'https://x/y', channelId: '222222222222222222', isActive: true, webhookSecret: 'TOP-SECRET-VALUE' },
  ]);
  prismaMock.xpConfig.findFirst.mockResolvedValue({ id: 'xp1', maxLevel: 100, isActive: true });
  prismaMock.levelRole.findMany.mockResolvedValue([]);
});

describe('Bot-Admin — Berechtigungs-Gates', () => {
  it('GET /overview ohne bot.view -> 403', async () => {
    setScope([]);
    const r = await request(makeApp()).get(`${BASE}/overview`);
    expect(r.status).toBe(403);
  });

  it('GET /overview mit bot.view -> 200 mit Stats', async () => {
    setScope(['bot.view']);
    const r = await request(makeApp()).get(`${BASE}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.stats).toMatchObject({ openAppeals: 3, newFeedback: 2, pendingValidations: 1 });
  });

  it('POST /upload/toggle mit nur bot.view -> 403', async () => {
    setScope(['bot.view']);
    const r = await request(makeApp()).post(`${BASE}/upload/toggle`).send({ enable: false });
    expect(r.status).toBe(403);
  });

  it('POST /upload/toggle mit bot.manage -> 200', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/upload/toggle`).send({ enable: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(prismaMock.botConfig.upsert).toHaveBeenCalled();
  });
});

describe('Bot-Admin — gefaehrliche Aktionen (bot.danger)', () => {
  it('Broadcast an ALLE mit nur bot.manage -> 403', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'hi' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/bot\.danger/);
  });

  it('Broadcast dryRun an MANUFACTURER mit bot.manage -> 200', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'MANUFACTURER', message: 'hi', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
  });

  it('Nutzer-/GDPR-Export mit nur bot.manage -> 403', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/export`).send({ type: 'users' });
    expect(r.status).toBe(403);
  });

  it('Paket-Export mit bot.manage -> 200', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/export`).send({ type: 'packages' });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('packages');
  });

  it('Gefahrenzone-Purge ohne bot.danger -> 403', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/danger/purge-deleted-packages`).send({ confirm: 'DELETE' });
    expect(r.status).toBe(403);
  });

  it('Gefahrenzone-Purge mit bot.danger aber ohne Confirm -> 400', async () => {
    setScope(['bot.danger']);
    const r = await request(makeApp()).post(`${BASE}/danger/purge-deleted-packages`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/DELETE/);
  });

  it('Gefahrenzone-Purge mit bot.danger + Confirm "DELETE" -> 200', async () => {
    setScope(['bot.danger']);
    const r = await request(makeApp()).post(`${BASE}/danger/purge-deleted-packages`).send({ confirm: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.purged).toBe(7);
  });

  it('Owner darf gefaehrliche Aktionen (Broadcast ALL dryRun)', async () => {
    setScope([], true);
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'hi', dryRun: true });
    expect(r.status).toBe(200);
  });
});

describe('Bot-Admin — Secret-Redaktion & Validierung', () => {
  it('GET /feeds gibt webhookSecret NIE aus', async () => {
    setScope(['bot.view']);
    const r = await request(makeApp()).get(`${BASE}/feeds`);
    expect(r.status).toBe(200);
    const dump = JSON.stringify(r.body);
    expect(dump).not.toMatch(/webhookSecret/);
    expect(dump).not.toMatch(/TOP-SECRET-VALUE/);
    expect(r.body.items[0]).toMatchObject({ id: 'f1', name: 'RSS' });
  });

  it('Broadcast mit ungueltigem Target -> 400', async () => {
    setScope(['bot.manage']);
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'NOPE', message: 'hi' });
    expect(r.status).toBe(400);
  });

  it('GET /xp liefert config + levelRoles', async () => {
    setScope(['bot.view']);
    const r = await request(makeApp()).get(`${BASE}/xp`);
    expect(r.status).toBe(200);
    expect(r.body.config).toMatchObject({ id: 'xp1' });
    expect(Array.isArray(r.body.levelRoles)).toBe(true);
  });

  it('GET /appeals liefert paginierte Liste', async () => {
    setScope(['bot.view']);
    const r = await request(makeApp()).get(`${BASE}/appeals`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('items');
    expect(r.body).toHaveProperty('total');
  });
});
