/**
 * Smoke + Pen-Tests fuer /api/v2/bot-admin/* (GLOBALER Bot-Admin-Bereich).
 *
 * Verifiziert Passwort-Login + BotAdminSession-Gate (requireBotAdmin), die
 * Confirm-Pflicht fuer gefaehrliche Aktionen, die guildId-Pflicht guild-gebundener
 * Routen und dass NIE Secrets ausgegeben werden (insb. Feed-webhookSecret).
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
  botAdminSession: {
    findFirst: jest.fn().mockResolvedValue({ expiresAt: new Date(Date.now() + 3_600_000) }),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    create: jest.fn().mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() + 3_600_000) }),
  },
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

// requireBotAdmin gegen einen mutierbaren "Session aktiv"-Schalter mocken.
const sessionRef = { active: true };

jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireBotAdmin: (
    req: { auth?: unknown; botAdminSession?: unknown },
    res: { status: (n: number) => { json: (b: unknown) => void } },
    next: () => void,
  ) => {
    req.auth = { userId: 'user-1', discordId: '888888888888888888', role: 'USER' };
    if (!sessionRef.active) { res.status(403).json({ error: 'Bot-Admin-Session erforderlich.', code: 'BOTADMIN_LOGIN_REQUIRED' }); return; }
    req.botAdminSession = { id: 's1', userDiscordId: '888888888888888888', expiresAt: new Date(Date.now() + 3_600_000) };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { botAdminRouter } from '../../src/dashboard/routes/v2/botAdmin';

function makeApp() {
  const app = express();
  app.use(express.json());
  // requireAuth-Ersatz: setzt req.auth global (wie im echten v2-Stack).
  app.use((req: express.Request, _res, next) => {
    (req as unknown as { auth: unknown }).auth = { userId: 'user-1', discordId: '888888888888888888', role: 'USER' };
    next();
  });
  app.use('/api/v2/bot-admin', botAdminRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = '/api/v2/bot-admin';
const GID = '999999999999999999';

beforeEach(() => {
  jest.clearAllMocks();
  sessionRef.active = true;
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
  prismaMock.botAdminSession.findFirst.mockResolvedValue({ expiresAt: new Date(Date.now() + 3_600_000) });
  prismaMock.botAdminSession.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.botAdminSession.create.mockResolvedValue({ id: 's1', expiresAt: new Date(Date.now() + 3_600_000) });
});

describe('Bot-Admin — Passwort-Login & Session', () => {
  it('POST /login mit falschem Passwort -> 403', async () => {
    const r = await request(makeApp()).post(`${BASE}/login`).send({ password: 'falsch' });
    expect(r.status).toBe(403);
    expect(prismaMock.botAdminSession.create).not.toHaveBeenCalled();
  });

  it('POST /login mit korrektem Passwort (ASH-Default) -> 200 + Session', async () => {
    const r = await request(makeApp()).post(`${BASE}/login`).send({ password: 'ASH' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(prismaMock.botAdminSession.create).toHaveBeenCalled();
  });

  it('POST /login ohne Passwort -> 400', async () => {
    const r = await request(makeApp()).post(`${BASE}/login`).send({});
    expect(r.status).toBe(400);
  });

  it('GET /status meldet aktive Session', async () => {
    const r = await request(makeApp()).get(`${BASE}/status`);
    expect(r.status).toBe(200);
    expect(r.body.active).toBe(true);
  });
});

describe('Bot-Admin — Session-Gate (requireBotAdmin)', () => {
  it('GET /overview ohne aktive Session -> 403', async () => {
    sessionRef.active = false;
    const r = await request(makeApp()).get(`${BASE}/overview`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('BOTADMIN_LOGIN_REQUIRED');
  });

  it('GET /overview mit aktiver Session -> 200 mit Stats', async () => {
    const r = await request(makeApp()).get(`${BASE}/overview`);
    expect(r.status).toBe(200);
    expect(r.body.stats).toMatchObject({ openAppeals: 3, newFeedback: 2, pendingValidations: 1 });
  });

  it('POST /upload/toggle in Session -> 200', async () => {
    const r = await request(makeApp()).post(`${BASE}/upload/toggle`).send({ enable: false });
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(false);
    expect(prismaMock.botConfig.upsert).toHaveBeenCalled();
  });
});

describe('Bot-Admin — gefaehrliche Aktionen', () => {
  it('Broadcast dryRun an ALLE in Session -> 200 (keine Extra-Berechtigung noetig)', async () => {
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'ALL', message: 'hi', dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body.dryRun).toBe(true);
  });

  it('Nutzer-/GDPR-Export in Session -> 200', async () => {
    const r = await request(makeApp()).post(`${BASE}/export`).send({ type: 'users' });
    expect(r.status).toBe(200);
    expect(r.body.type).toBe('users');
  });

  it('Gefahrenzone-Purge ohne Confirm -> 400', async () => {
    const r = await request(makeApp()).post(`${BASE}/danger/purge-deleted-packages`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/DELETE/);
  });

  it('Gefahrenzone-Purge mit Confirm "DELETE" -> 200', async () => {
    const r = await request(makeApp()).post(`${BASE}/danger/purge-deleted-packages`).send({ confirm: 'DELETE' });
    expect(r.status).toBe(200);
    expect(r.body.purged).toBe(7);
  });
});

describe('Bot-Admin — guild-gebundene Routen', () => {
  it('GET /feeds ohne guildId -> 400', async () => {
    const r = await request(makeApp()).get(`${BASE}/feeds`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/guildId/);
  });

  it('GET /feeds mit guildId gibt webhookSecret NIE aus', async () => {
    const r = await request(makeApp()).get(`${BASE}/feeds?guildId=${GID}`);
    expect(r.status).toBe(200);
    const dump = JSON.stringify(r.body);
    expect(dump).not.toMatch(/webhookSecret/);
    expect(dump).not.toMatch(/TOP-SECRET-VALUE/);
    expect(r.body.items[0]).toMatchObject({ id: 'f1', name: 'RSS' });
  });
});

describe('Bot-Admin — Validierung & Listen', () => {
  it('Broadcast mit ungueltigem Target -> 400', async () => {
    const r = await request(makeApp()).post(`${BASE}/broadcast`).send({ target: 'NOPE', message: 'hi' });
    expect(r.status).toBe(400);
  });

  it('GET /xp liefert config + (leere) levelRoles ohne guildId', async () => {
    const r = await request(makeApp()).get(`${BASE}/xp`);
    expect(r.status).toBe(200);
    expect(r.body.config).toMatchObject({ id: 'xp1' });
    expect(Array.isArray(r.body.levelRoles)).toBe(true);
  });

  it('GET /appeals liefert paginierte Liste', async () => {
    const r = await request(makeApp()).get(`${BASE}/appeals`);
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('items');
    expect(r.body).toHaveProperty('total');
  });
});
