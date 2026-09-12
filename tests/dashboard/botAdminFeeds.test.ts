process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD_ID = '999999999999999999';
const ACTOR_ID = '888888888888888888';
const USER_ID = 'user-1';

type FeedRow = {
  id: string;
  guildId: string;
  name: string;
  feedType: string;
  url: string;
  channelId: string;
  interval: number;
  isActive: boolean;
  webhookSecret: string | null;
  credentialsEnc: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const rows = new Map<string, FeedRow>();
const prismaMock = {
  feed: {
    findMany: jest.fn(async ({ where }: { where: { guildId: string } }) =>
      [...rows.values()].filter(row => row.guildId === where.guildId)),
    findFirst: jest.fn(async ({ where }: { where: { id: string; guildId: string } }) => {
      const row = rows.get(where.id);
      return row && row.guildId === where.guildId ? row : null;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: { id: string; guildId: string }; data: Partial<FeedRow> }) => {
      const row = rows.get(where.id);
      if (!row || row.guildId !== where.guildId) return { count: 0 };
      Object.assign(row, data, { updatedAt: new Date() });
      return { count: 1 };
    }),
    deleteMany: jest.fn(async ({ where }: { where: { id: string; guildId: string } }) => {
      const row = rows.get(where.id);
      if (!row || row.guildId !== where.guildId) return { count: 0 };
      rows.delete(where.id);
      return { count: 1 };
    }),
  },
};

const createCanonicalFeedMock = jest.fn();
const isSupportedFeedTypeMock = jest.fn((value: string) => ['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK'].includes(value));

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/dashboard/services/feedControlPlane', () => ({
  __esModule: true,
  createCanonicalFeed: (...args: unknown[]) => createCanonicalFeedMock(...args),
  isSupportedFeedType: (value: string) => isSupportedFeedTypeMock(value),
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAuditDb: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { botAdminFeedsRouter } from '../../src/dashboard/routes/v2/botAdminFeeds';

function row(id: string, feedType = 'RSS', isActive = true): FeedRow {
  const now = new Date('2026-09-12T04:00:00.000Z');
  return {
    id,
    guildId: GUILD_ID,
    name: `Feed ${id}`,
    feedType,
    url: 'https://example.com/feed',
    channelId: '222222222222222222',
    interval: 300,
    isActive,
    webhookSecret: 'secret-value',
    credentialsEnc: 'encrypted-value',
    createdAt: now,
    updatedAt: now,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { auth: unknown }).auth = { userId: USER_ID, discordId: ACTOR_ID, role: 'ADMIN' };
    next();
  });
  app.use('/api/v2/bot-admin/feeds', botAdminFeedsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  rows.clear();
  createCanonicalFeedMock.mockResolvedValue({
    ok: true,
    feedId: 'new-feed',
    name: 'Created',
    feedType: 'RSS',
    sourceId: 'rss:https://example.com/feed',
    url: 'https://example.com/feed',
    channelId: '222222222222222222',
    interval: 300,
    mentionRoles: [],
    credentialsSet: false,
    hasWebhookSecret: false,
  });
});

describe('botAdminFeedsRouter', () => {
  test('redacts webhook and credential secrets from list responses', async () => {
    rows.set('feed-1', row('feed-1'));
    const res = await request(makeApp()).get(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('webhookSecret');
    expect(res.body.items[0]).not.toHaveProperty('credentialsEnc');
    expect(res.body.items[0]).toMatchObject({ hasWebhookSecret: true, hasCredentials: true });
  });

  test('delegates creation to the canonical control plane with authenticated actor', async () => {
    const body = {
      name: 'News',
      feedType: 'RSS',
      url: 'https://example.com/rss',
      channelId: '222222222222222222',
    };
    const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`).send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'new-feed' });
    expect(createCanonicalFeedMock).toHaveBeenCalledWith({ guildId: GUILD_ID, createdBy: ACTOR_ID, body });
  });

  test('returns canonical validation errors without persistence fallback', async () => {
    createCanonicalFeedMock.mockResolvedValue({ ok: false, error: 'Ungültiger Feed-Typ.' });
    const res = await request(makeApp())
      .post(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`)
      .send({ name: 'Old', feedType: 'TWITTER', url: 'x', channelId: '222222222222222222' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Feed-Typ/);
  });

  test('does not reactivate unsupported legacy feed types', async () => {
    rows.set('legacy', row('legacy', 'CUSTOM', false));
    const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds/legacy/toggle?guildId=${GUILD_ID}`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Legacy-Feed-Typ CUSTOM/);
    expect(prismaMock.feed.updateMany).not.toHaveBeenCalled();
    expect(rows.get('legacy')?.isActive).toBe(false);
  });

  test('can still deactivate and delete legacy rows safely', async () => {
    rows.set('legacy', row('legacy', 'TWITTER', true));
    const off = await request(makeApp()).post(`/api/v2/bot-admin/feeds/legacy/toggle?guildId=${GUILD_ID}`).send({});
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect(prismaMock.feed.updateMany).toHaveBeenCalledWith({ where: { id: 'legacy', guildId: GUILD_ID }, data: { isActive: false } });

    const del = await request(makeApp()).delete(`/api/v2/bot-admin/feeds/legacy?guildId=${GUILD_ID}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true });
    expect(prismaMock.feed.deleteMany).toHaveBeenCalledWith({ where: { id: 'legacy', guildId: GUILD_ID } });
    expect(rows.has('legacy')).toBe(false);
  });

  test('reactivates supported feeds normally', async () => {
    rows.set('rss', row('rss', 'RSS', false));
    const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds/rss/toggle?guildId=${GUILD_ID}`).send({});

    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(true);
    expect(rows.get('rss')?.isActive).toBe(true);
  });

  test('returns conflict if a scoped mutation no longer affects exactly one row', async () => {
    rows.set('rss', row('rss', 'RSS', false));
    prismaMock.feed.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds/rss/toggle?guildId=${GUILD_ID}`).send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/zwischenzeitlich geändert/);
  });

  test('requires a valid guild scope', async () => {
    const res = await request(makeApp()).get('/api/v2/bot-admin/feeds?guildId=bad');
    expect(res.status).toBe(400);
    expect(prismaMock.feed.findMany).not.toHaveBeenCalled();
  });
});
