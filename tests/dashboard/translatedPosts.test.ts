process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Übersetzungen-Router (Dashboard-only, ersetzt /translate-post):
 * CRUD, Modi now/once/recurring, Sprach-/SSRF-Validierung. In-Memory-Prisma.
 */

const GID = '999999999999999999';
const OTHER_GID = '111111111111111111';
const ACTOR = '888888888888888888';
const CH = '222222222222222222';
const ROLE = '333333333333333301';

interface Row { id: string; [k: string]: unknown }
const posts = new Map<string, Row>();
let seq = 0;

function match(r: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => v === undefined || r[k] === v);
}

const prismaMock = {
  translatedPost: {
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...posts.values()].filter(r => match(r, where))),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...posts.values()].find(r => match(r, where)) ?? null),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const id = `p${seq}`;
      const row = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      posts.set(id, row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = posts.get(where.id as string)!;
      Object.assign(r, data);
      return r;
    }),
    delete: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = posts.get(where.id as string)!;
      posts.delete(where.id as string);
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
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => ({ channels: { fetch: jest.fn() } }),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (req: { auth?: unknown; guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'user-1', discordId: ACTOR, role: 'USER' };
    req.guildScope = { guildId: GID, actorDiscordId: ACTOR, permissions: ['translate.manage'] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { translatedPostsRouter } from '../../src/dashboard/routes/v2/translatedPosts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/translated-posts', translatedPostsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = `/api/v2/guilds/${GID}/translated-posts`;

beforeEach(() => {
  jest.clearAllMocks();
  posts.clear();
  seq = 0;
});

async function createPost(app: express.Express, body: Record<string, unknown> = {}) {
  return request(app).post(BASE).send({
    channelId: CH, sourceText: 'Hallo Welt', targetLang: 'de',
    customTitle: 'Titel', mode: 'now', ...body,
  });
}

describe('Übersetzungen-Router — CRUD & Validierung', () => {
  it('erstellt einen Sofort-Post (now)', async () => {
    const app = makeApp();
    const res = await createPost(app);
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('now');
    expect(res.body.nextRunAt).toBeTruthy();
  });

  it('lehnt ungültige Zielsprache ab', async () => {
    const app = makeApp();
    const res = await createPost(app, { targetLang: 'xx' });
    expect(res.status).toBe(400);
  });

  it('erfordert einen Titel', async () => {
    const app = makeApp();
    const res = await createPost(app, { customTitle: '' });
    expect(res.status).toBe(400);
  });

  it('lehnt leeren Text ab', async () => {
    const app = makeApp();
    const res = await createPost(app, { sourceText: '' });
    expect(res.status).toBe(400);
  });

  it('lehnt ungültige channelId ab', async () => {
    const app = makeApp();
    const res = await createPost(app, { channelId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('erstellt einen geplanten Post (once) in der Zukunft', async () => {
    const app = makeApp();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const res = await createPost(app, { mode: 'once', scheduledAt: future });
    expect(res.status).toBe(201);
    expect(res.body.scheduledFor).toBeTruthy();
  });

  it('lehnt once-Post in der Vergangenheit ab', async () => {
    const app = makeApp();
    const past = new Date(Date.now() - 3600_000).toISOString();
    const res = await createPost(app, { mode: 'once', scheduledAt: past });
    expect(res.status).toBe(400);
  });

  it('erstellt wiederkehrenden Post (recurring)', async () => {
    const app = makeApp();
    const res = await createPost(app, { mode: 'recurring', recurrence: 'DAILY:09:00' });
    expect(res.status).toBe(201);
    expect(res.body.recurrenceCron).toBe('DAILY:09:00');
    expect(res.body.nextRunAt).toBeTruthy();
  });

  it('lehnt ungültige Wiederholung ab', async () => {
    const app = makeApp();
    const res = await createPost(app, { mode: 'recurring', recurrence: 'GARBAGE' });
    expect(res.status).toBe(400);
  });

  it('blockt SSRF-Bild-URLs', async () => {
    const app = makeApp();
    const res = await createPost(app, { imageUrl: 'http://127.0.0.1/x.png' });
    expect(res.status).toBe(400);
  });

  it('normalisiert Rollen-Pings (max 3, nur Snowflakes)', async () => {
    const app = makeApp();
    const res = await createPost(app, { rolePings: [ROLE, 'invalid', ROLE] });
    expect(res.status).toBe(201);
    expect(res.body.rolePings).toEqual([ROLE]);
  });
});

describe('Übersetzungen-Router — scope & lifecycle', () => {
  it('listet nur Posts der eigenen Guild', async () => {
    const app = makeApp();
    await createPost(app);
    posts.set('foreign', { id: 'foreign', guildId: OTHER_GID, channelId: CH, mode: 'now', isActive: true, rolePings: null });
    const res = await request(app).get(BASE);
    expect(res.body.posts).toHaveLength(1);
  });

  it('liefert unterstützte Sprachen', async () => {
    const app = makeApp();
    const res = await request(app).get(`${BASE}/meta/languages`);
    expect(res.status).toBe(200);
    expect(res.body.languages.some((l: { code: string }) => l.code === 'de')).toBe(true);
  });

  it('togglet und löscht einen Post', async () => {
    const app = makeApp();
    const c = await createPost(app);
    const t = await request(app).post(`${BASE}/${c.body.id}/toggle`).send({ isActive: false });
    expect(t.status).toBe(200);
    const d = await request(app).delete(`${BASE}/${c.body.id}`);
    expect(d.status).toBe(200);
    expect(posts.has(c.body.id)).toBe(false);
  });

  it('aktualisiert Zielsprache und setzt Übersetzung zurück', async () => {
    const app = makeApp();
    const c = await createPost(app);
    const res = await request(app).put(`${BASE}/${c.body.id}`).send({ targetLang: 'en' });
    expect(res.status).toBe(200);
    expect(res.body.targetLang).toBe('en');
  });
});
