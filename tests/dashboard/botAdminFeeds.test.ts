process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD_ID = '999999999999999999';
const ACTOR_ID = '888888888888888888';
const USER_ID = 'user-1';
const CHANNEL_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';

type FeedRow = {
  id: string;
  guildId: string;
  name: string;
  feedType: string;
  url: string;
  channelId: string;
  interval: number;
  lastChecked: Date | null;
  lastItemId: string | null;
  isActive: boolean;
  mentionRoles: string[];
  webhookSecret: string | null;
  credentialsEnc: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

const rows = new Map<string, FeedRow>();
let seq = 0;

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

const createFeedMock = jest.fn(async (
  name: string,
  feedType: string,
  url: string,
  channelId: string,
  interval: number,
  createdBy: string,
  guildId: string,
  _filters: unknown,
  initial: { mentionRoles?: string[]; webhookSecret?: string | null; credentialsEnc?: string | null },
) => {
  seq += 1;
  const id = `feed-${seq}`;
  const now = new Date('2026-09-12T04:00:00.000Z');
  rows.set(id, {
    id, guildId, name, feedType, url, channelId, interval,
    lastChecked: null, lastItemId: null, isActive: true,
    mentionRoles: initial.mentionRoles ?? [], webhookSecret: initial.webhookSecret ?? null,
    credentialsEnc: initial.credentialsEnc ?? null, createdBy, createdAt: now, updatedAt: now,
  });
  return id;
});
const runFeedNowMock = jest.fn().mockResolvedValue(undefined);
const resolveCredentialUpdateMock = jest.fn().mockReturnValue({ ok: true, change: false });

const fakeGuild = {
  channels: { cache: new Map([
    [CHANNEL_ID, { id: CHANNEL_ID, name: 'feed-news', type: 0, parentId: null }],
    ['444444444444444444', { id: '444444444444444444', name: 'voice', type: 2, parentId: null }],
  ]) },
  roles: { cache: new Map([
    [GUILD_ID, { id: GUILD_ID, name: '@everyone', hexColor: '#000000', position: 0, managed: false }],
    [ROLE_ID, { id: ROLE_ID, name: 'News', hexColor: '#ffffff', position: 5, managed: false }],
  ]) },
};
const fakeClient = { guilds: { cache: new Map([[GUILD_ID, fakeGuild]]) } };

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/feeds/feedManager', () => ({
  __esModule: true,
  createFeed: (...args: unknown[]) => createFeedMock(...(args as Parameters<typeof createFeedMock>)),
  runFeedNow: (...args: unknown[]) => runFeedNowMock(...args),
}));
jest.mock('../../src/modules/feeds/feedCredentials', () => ({
  __esModule: true,
  resolveCredentialUpdate: (...args: unknown[]) => resolveCredentialUpdateMock(...args),
}));
jest.mock('../../src/modules/feeds/webhookReceiver', () => ({
  __esModule: true,
  generateWebhookSecret: () => 'rotated-secret',
}));
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => fakeClient,
}));
jest.mock('../../src/utils/discordChannel', () => ({
  __esModule: true,
  validateBotChannelAccess: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAuditDb: jest.fn(),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import { botAdminFeedsRouter } from '../../src/dashboard/routes/v2/botAdminFeeds';
import { asUserDiscordId } from '../../src/types/scope';

function row(id: string, feedType = 'RSS', isActive = true): FeedRow {
  const now = new Date('2026-09-12T04:00:00.000Z');
  return {
    id,
    guildId: GUILD_ID,
    name: `Feed ${id}`,
    feedType,
    url: feedType === 'WEBHOOK' ? 'Build Hook' : 'https://example.com/feed',
    channelId: CHANNEL_ID,
    interval: 300,
    lastChecked: null,
    lastItemId: null,
    isActive,
    mentionRoles: [],
    webhookSecret: feedType === 'WEBHOOK' ? 'secret-value' : null,
    credentialsEnc: 'encrypted-value',
    createdBy: ACTOR_ID,
    createdAt: now,
    updatedAt: now,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { userId: USER_ID, discordId: asUserDiscordId(ACTOR_ID), role: 'ADMIN' };
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
  seq = 0;
  resolveCredentialUpdateMock.mockReturnValue({ ok: true, change: false });
});

describe('botAdminFeedsRouter', () => {
  test('redacts webhook and credential secrets from list responses', async () => {
    rows.set('feed-1', row('feed-1'));
    const res = await request(makeApp()).get(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('webhookSecret');
    expect(res.body.items[0]).not.toHaveProperty('credentialsEnc');
    expect(res.body.items[0]).toMatchObject({ hasWebhookSecret: false, hasCredentials: true });
  });

  test('creates through the canonical control plane and returns the shared API shape', async () => {
    const body = { name: 'News', feedType: 'RSS', url: 'https://example.com/rss', channelId: CHANNEL_ID };
    const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`).send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'feed-1', name: 'News', feedType: 'RSS', channelId: CHANNEL_ID, hasCredentials: false });
    expect(createFeedMock).toHaveBeenCalledTimes(1);
  });

  test('rejects legacy TWITTER and CUSTOM on create', async () => {
    for (const feedType of ['TWITTER', 'CUSTOM']) {
      const res = await request(makeApp()).post(`/api/v2/bot-admin/feeds?guildId=${GUILD_ID}`)
        .send({ name: 'Old', feedType, url: 'https://example.com/feed', channelId: CHANNEL_ID });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Feed-Typ/);
    }
    expect(createFeedMock).not.toHaveBeenCalled();
  });

  test('does not reactivate unsupported legacy feed types but can deactivate them', async () => {
    rows.set('legacy', row('legacy', 'CUSTOM', false));
    const on = await request(makeApp()).post(`/api/v2/bot-admin/feeds/legacy/toggle?guildId=${GUILD_ID}`).send({ isActive: true });
    expect(on.status).toBe(409);
    expect(on.body.error).toMatch(/Legacy-Feed-Typ CUSTOM/);
    expect(rows.get('legacy')?.isActive).toBe(false);

    rows.get('legacy')!.isActive = true;
    const off = await request(makeApp()).post(`/api/v2/bot-admin/feeds/legacy/toggle?guildId=${GUILD_ID}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(rows.get('legacy')?.isActive).toBe(false);
  });

  test('supports shared update, test, roles and webhook operations', async () => {
    rows.set('rss', row('rss'));
    const update = await request(makeApp()).put(`/api/v2/bot-admin/feeds/rss?guildId=${GUILD_ID}`).send({ name: 'Renamed', interval: 600 });
    expect(update.status).toBe(200);
    expect(update.body).toMatchObject({ name: 'Renamed', interval: 600 });

    const test = await request(makeApp()).post(`/api/v2/bot-admin/feeds/rss/test?guildId=${GUILD_ID}`).send({});
    expect(test.status).toBe(200);
    expect(runFeedNowMock).toHaveBeenCalledWith(fakeClient, 'rss');

    const addRole = await request(makeApp()).post(`/api/v2/bot-admin/feeds/rss/roles?guildId=${GUILD_ID}`).send({ roleId: ROLE_ID });
    expect(addRole.status).toBe(200);
    expect(addRole.body.mentionRoles).toContain(ROLE_ID);
    const removeRole = await request(makeApp()).delete(`/api/v2/bot-admin/feeds/rss/roles/${ROLE_ID}?guildId=${GUILD_ID}`);
    expect(removeRole.status).toBe(200);
    expect(removeRole.body.mentionRoles).not.toContain(ROLE_ID);

    rows.set('hook', row('hook', 'WEBHOOK'));
    const info = await request(makeApp()).get(`/api/v2/bot-admin/feeds/hook/webhook?guildId=${GUILD_ID}`);
    expect(info.status).toBe(200);
    expect(info.body.secret).toBe('secret-value');
    const rotate = await request(makeApp()).post(`/api/v2/bot-admin/feeds/hook/webhook/rotate?guildId=${GUILD_ID}`).send({});
    expect(rotate.status).toBe(200);
    expect(rotate.body.secret).toBe('rotated-secret');
  });

  test('exposes BotAdmin-scoped channel and role selectors for the shared UI', async () => {
    const channels = await request(makeApp()).get(`/api/v2/bot-admin/feeds/channels?guildId=${GUILD_ID}`);
    expect(channels.status).toBe(200);
    expect(channels.body.channels).toEqual([{ id: CHANNEL_ID, name: 'feed-news', type: 0, parentId: null }]);

    const roles = await request(makeApp()).get(`/api/v2/bot-admin/feeds/roles?guildId=${GUILD_ID}`);
    expect(roles.status).toBe(200);
    expect(roles.body.roles.map((role: { id: string }) => role.id)).toEqual([ROLE_ID, GUILD_ID]);
  });

  test('deletes only inside the requested guild scope and reports mutation conflicts', async () => {
    rows.set('rss', row('rss'));
    prismaMock.feed.deleteMany.mockResolvedValueOnce({ count: 0 });
    const conflict = await request(makeApp()).delete(`/api/v2/bot-admin/feeds/rss?guildId=${GUILD_ID}`);
    expect(conflict.status).toBe(409);
    expect(rows.has('rss')).toBe(true);

    const ok = await request(makeApp()).delete(`/api/v2/bot-admin/feeds/rss?guildId=${GUILD_ID}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ deleted: true });
    expect(rows.has('rss')).toBe(false);
  });

  test('requires a valid guild scope', async () => {
    const res = await request(makeApp()).get('/api/v2/bot-admin/feeds?guildId=bad');
    expect(res.status).toBe(400);
    expect(prismaMock.feed.findMany).not.toHaveBeenCalled();
  });
});
