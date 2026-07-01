process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Feeds-Router (Dashboard-only, ersetzt /feed): CRUD, Typ-/SSRF-Validierung,
 * YouTube-Quellen, Ping-Rollen, Webhook-Secret. In-Memory-Prisma + Fakes.
 */

const GID = '999999999999999999';
const OTHER_GID = '111111111111111111';
const ACTOR = '888888888888888888';
const CH = '222222222222222222';
const ROLE = '333333333333333301';

interface Row { id: string; [k: string]: unknown }
const feeds = new Map<string, Row>();
let seq = 0;

function match(r: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => v === undefined || r[k] === v);
}

const prismaMock = {
  feed: {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...feeds.values()].filter(r => match(r, where))),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...feeds.values()].find(r => match(r, where)) ?? null),
    update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = feeds.get(where.id as string)!;
      Object.assign(r, data);
      return r;
    }),
    delete: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = feeds.get(where.id as string)!;
      feeds.delete(where.id as string);
      return r;
    }),
  },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAuditDb: jest.fn(),
  logAudit: jest.fn(),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));
jest.mock('../../src/utils/discordChannel', () => ({
  __esModule: true,
  validateBotChannelAccess: jest.fn().mockResolvedValue({ ok: true }),
}));

const runFeedNowMock = jest.fn().mockResolvedValue(undefined);
const createFeedMock = jest.fn(async (name: string, feedType: string, url: string, channelId: string, interval: number, createdBy: string, guildId: string) => {
  seq += 1;
  const id = `f${seq}`;
  feeds.set(id, {
    id, guildId, name, feedType, url, channelId, interval,
    lastChecked: null, lastItemId: null, isActive: true, mentionRoles: [],
    webhookSecret: null, createdBy, createdAt: new Date(), updatedAt: new Date(),
  });
  return id;
});
jest.mock('../../src/modules/feeds/feedManager', () => ({
  __esModule: true,
  createFeed: (...a: unknown[]) => createFeedMock(...(a as Parameters<typeof createFeedMock>)),
  runFeedNow: (...a: unknown[]) => runFeedNowMock(...a),
}));
jest.mock('../../src/modules/feeds/webhookReceiver', () => ({
  __esModule: true,
  generateWebhookSecret: () => 'secret-abc',
}));
const fakeClient = { channels: { fetch: jest.fn().mockResolvedValue({ isTextBased: () => true, isDMBased: () => false, guildId: GID }) } };
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => fakeClient,
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (req: { auth?: unknown; guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'user-1', discordId: ACTOR, role: 'USER' };
    req.guildScope = { guildId: GID, actorDiscordId: ACTOR, permissions: ['feeds.manage'] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { feedsRouter } from '../../src/dashboard/routes/v2/feeds';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/feeds', feedsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = `/api/v2/guilds/${GID}/feeds`;

beforeEach(() => {
  jest.clearAllMocks();
  feeds.clear();
  seq = 0;
});

async function createFeed(app: express.Express, body: Record<string, unknown> = {}) {
  return request(app).post(BASE).send({ name: 'News', feedType: 'RSS', url: 'https://example.com/rss', channelId: CH, ...body });
}

describe('Feeds-Router — CRUD & Validierung', () => {
  it('erstellt einen RSS-Feed', async () => {
    const app = makeApp();
    const res = await createFeed(app);
    expect(res.status).toBe(201);
    expect(res.body.feedType).toBe('RSS');
    expect(createFeedMock).toHaveBeenCalled();
  });

  it('lehnt unbekannten Feed-Typ ab', async () => {
    const app = makeApp();
    const res = await createFeed(app, { feedType: 'FOO' });
    expect(res.status).toBe(400);
  });

  it('lehnt ungültige channelId ab', async () => {
    const app = makeApp();
    const res = await createFeed(app, { channelId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('blockt SSRF-Hosts bei RSS', async () => {
    const app = makeApp();
    const res = await createFeed(app, { url: 'http://127.0.0.1/rss' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SSRF|lokal/i);
  });

  it('akzeptiert YouTube-Kanal-ID', async () => {
    const app = makeApp();
    const res = await createFeed(app, { feedType: 'YOUTUBE', url: 'UCabcdefghijklmnopqrstuv' });
    expect(res.status).toBe(201);
  });

  it('akzeptiert YouTube-Handle', async () => {
    const app = makeApp();
    const res = await createFeed(app, { feedType: 'YOUTUBE', url: '@mychannel' });
    expect(res.status).toBe(201);
  });

  it('lehnt ungültige Twitch-Namen ab', async () => {
    const app = makeApp();
    const res = await createFeed(app, { feedType: 'TWITCH', url: 'ab' });
    expect(res.status).toBe(400);
  });

  it('erzeugt Webhook-Secret bei WEBHOOK-Feed', async () => {
    const app = makeApp();
    const res = await createFeed(app, { feedType: 'WEBHOOK', url: 'Mein Webhook' });
    expect(res.status).toBe(201);
    expect(res.body.hasWebhookSecret).toBe(true);
  });

  it('listet nur Feeds der eigenen Guild', async () => {
    const app = makeApp();
    await createFeed(app);
    feeds.set('foreign', { id: 'foreign', guildId: OTHER_GID, name: 'X', feedType: 'RSS', url: 'https://x.de', channelId: CH, isActive: true, mentionRoles: [] });
    const res = await request(app).get(BASE);
    expect(res.body.feeds).toHaveLength(1);
  });
});

describe('Feeds-Router — toggle / test / roles / webhook', () => {
  it('toggelt einen Feed', async () => {
    const app = makeApp();
    const c = await createFeed(app);
    const res = await request(app).post(`${BASE}/${c.body.id}/toggle`).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
  });

  it('prüft einen Feed sofort (test)', async () => {
    const app = makeApp();
    const c = await createFeed(app);
    const res = await request(app).post(`${BASE}/${c.body.id}/test`).send({});
    expect(res.status).toBe(200);
    expect(runFeedNowMock).toHaveBeenCalledWith(fakeClient, c.body.id);
  });

  it('fügt eine Ping-Rolle hinzu und entfernt sie', async () => {
    const app = makeApp();
    const c = await createFeed(app);
    const add = await request(app).post(`${BASE}/${c.body.id}/roles`).send({ roleId: ROLE });
    expect(add.body.mentionRoles).toContain(ROLE);
    const del = await request(app).delete(`${BASE}/${c.body.id}/roles/${ROLE}`);
    expect(del.body.mentionRoles).not.toContain(ROLE);
  });

  it('rotiert Webhook-Secret nur bei WEBHOOK-Feeds', async () => {
    const app = makeApp();
    const rss = await createFeed(app);
    const bad = await request(app).post(`${BASE}/${rss.body.id}/webhook/rotate`).send({});
    expect(bad.status).toBe(400);
    const wh = await createFeed(app, { feedType: 'WEBHOOK', url: 'Hook' });
    const ok = await request(app).post(`${BASE}/${wh.body.id}/webhook/rotate`).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.secret).toBe('secret-abc');
  });

  it('löscht einen Feed', async () => {
    const app = makeApp();
    const c = await createFeed(app);
    const res = await request(app).delete(`${BASE}/${c.body.id}`);
    expect(res.status).toBe(200);
    expect(feeds.has(c.body.id)).toBe(false);
  });
});
