// Minimal nötige ENV-Variablen für config.ts (defensiv).
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Embed-Builder (Dashboard-only): Helper-Validierung + Router-CRUD/Send.
 *
 * Deckt ab:
 *   - buildDiscordEmbed / parseEmbedColor / validateEmbedContent (Discord-Limits)
 *   - extractChannelAnchors / embedHasContent
 *   - Router: CRUD, Validierungs-Fehler, duplicate, send (mit Fake-Client)
 */

const GID = '999999999999999999';
const ACTOR = '888888888888888888';

// ── In-Memory Prisma-Store ──────────────────────────────────────────────────
interface Row { id: string; messageId: string | null; [k: string]: unknown }
const store = new Map<string, Row>();
let seq = 0;

const prismaMock = {
  dashboardEmbed: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const row: Row = { id: `e${seq}`, messageId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      store.set(row.id, row);
      return row;
    }),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...store.values()].filter(r =>
        r.guildId === where.guildId &&
        (where.isTemplate === undefined || r.isTemplate === where.isTemplate) &&
        (where.isDraft === undefined || r.isDraft === where.isDraft),
      ),
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...store.values()].find(r => r.id === where.id && r.guildId === where.guildId) ?? null,
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = store.get(where.id as string);
      if (r && r.guildId === where.guildId) { Object.assign(r, data); return { count: 1 }; }
      return { count: 0 };
    }),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = store.get(where.id as string);
      if (r && r.guildId === where.guildId) { store.delete(where.id as string); return { count: 1 }; }
      return { count: 0 };
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

// Channel-Zugriffspruefung neutralisieren (Bot-Permissions nicht Teil dieses Tests).
jest.mock('../../src/utils/discordChannel', () => ({
  __esModule: true,
  validateBotChannelAccess: jest.fn().mockResolvedValue({ ok: true }),
}));

// Fake Discord-Client fuer den Send-Pfad.
const fakeMessageEdit = jest.fn().mockResolvedValue({});
const fakeChannel = {
  isTextBased: () => true,
  isDMBased: () => false,
  guildId: GID,
  send: jest.fn().mockResolvedValue({ id: 'msg-123' }),
  messages: {
    fetch: jest.fn().mockResolvedValue({ edit: fakeMessageEdit }),
    delete: jest.fn().mockResolvedValue({}),
  },
};
const fakeClient = { channels: { fetch: jest.fn().mockResolvedValue(fakeChannel) } };
let clientEnabled = true;
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => (clientEnabled ? fakeClient : null),
}));

// requireGuildPermission passieren lassen + Scope setzen.
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (
    req: { auth?: unknown; guildScope?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = { userId: 'user-1', discordId: ACTOR, role: 'USER' };
    req.guildScope = { guildId: GID, actorDiscordId: ACTOR, permissions: ['embeds.manage'] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { embedsRouter } from '../../src/dashboard/routes/v2/embeds';
import {
  buildDiscordEmbed,
  parseEmbedColor,
  validateEmbedContent,
  extractChannelAnchors,
  embedHasContent,
} from '../../src/modules/embeds/embedBuilder';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/embeds', embedsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = `/api/v2/guilds/${GID}/embeds`;

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  seq = 0;
  clientEnabled = true;
  fakeChannel.send.mockResolvedValue({ id: 'msg-123' });
  fakeClient.channels.fetch.mockResolvedValue(fakeChannel);
});

// ============================================================================
describe('embedBuilder Helper', () => {
  it('parseEmbedColor: #RRGGBB und #AARRGGBB', () => {
    expect(parseEmbedColor('#5865f2')).toBe(0x5865f2);
    expect(parseEmbedColor('5865f2')).toBe(0x5865f2);
    expect(parseEmbedColor('#ff5865f2')).toBe(0x5865f2); // Alpha verworfen
    expect(parseEmbedColor('')).toBeNull();
    expect(parseEmbedColor('xyz')).toBeNull();
  });

  it('validateEmbedContent: gültiger Embed -> null', () => {
    expect(validateEmbedContent({ title: 'Hallo', description: 'Welt' })).toBeNull();
  });

  it('validateEmbedContent: Titel zu lang -> Fehler', () => {
    expect(validateEmbedContent({ title: 'x'.repeat(257) })).toMatch(/Titel/);
  });

  it('validateEmbedContent: Gesamt-Limit 6000 -> Fehler', () => {
    expect(validateEmbedContent({ description: 'x'.repeat(4096), footerText: 'y'.repeat(2048) })).toMatch(/Gesamt-Limit/);
  });

  it('validateEmbedContent: zu viele Felder -> Fehler', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `n${i}`, value: 'v', inline: false }));
    expect(validateEmbedContent({ fields })).toMatch(/Felder/);
  });

  it('validateEmbedContent: ungültige URL -> Fehler', () => {
    expect(validateEmbedContent({ title: 'x', imageUrl: 'javascript:alert(1)' })).toMatch(/URL/);
  });

  it('validateEmbedContent: ungültige Farbe -> Fehler', () => {
    expect(validateEmbedContent({ title: 'x', color: 'nope' })).toMatch(/Farbe/);
  });

  it('extractChannelAnchors: findet eindeutige <#id>', () => {
    const ids = extractChannelAnchors({ description: 'siehe <#111111111111111111> und <#111111111111111111> und <#222222222222222222>' });
    expect(ids.sort()).toEqual(['111111111111111111', '222222222222222222']);
  });

  it('embedHasContent: leer -> false, mit Titel -> true', () => {
    expect(embedHasContent({})).toBe(false);
    expect(embedHasContent({ title: 'x' })).toBe(true);
  });

  it('buildDiscordEmbed: setzt Felder korrekt', () => {
    const e = buildDiscordEmbed({
      title: 'T', description: 'D', color: '#22c55e', showTimestamp: true,
      fields: [{ name: 'A', value: 'B', inline: true }],
    });
    const json = e.toJSON();
    expect(json.title).toBe('T');
    expect(json.description).toBe('D');
    expect(json.color).toBe(0x22c55e);
    expect(json.fields).toEqual([{ name: 'A', value: 'B', inline: true }]);
    expect(json.timestamp).toBeDefined();
  });
});

// ============================================================================
describe('Embed-Router CRUD', () => {
  it('POST / ohne Name -> 400', async () => {
    const r = await request(makeApp()).post(BASE).send({ title: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Name/);
  });

  it('POST / mit zu langem Titel -> 400', async () => {
    const r = await request(makeApp()).post(BASE).send({ name: 'Test', title: 'x'.repeat(257) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Titel/);
  });

  it('POST / -> 201 und in Liste sichtbar', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'Regeln', title: 'Serverregeln', description: 'Sei nett.' });
    expect(c.status).toBe(201);
    expect(c.body.id).toBeDefined();
    expect(c.body.isDraft).toBe(true);

    const list = await request(app).get(BASE);
    expect(list.status).toBe(200);
    expect(list.body.embeds).toHaveLength(1);
    expect(list.body.embeds[0].name).toBe('Regeln');
  });

  it('GET /:id fremde ID -> 404', async () => {
    const r = await request(makeApp()).get(`${BASE}/does-not-exist`);
    expect(r.status).toBe(404);
  });

  it('PUT /:id aktualisiert', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'A', title: 'Alt' });
    const u = await request(app).put(`${BASE}/${c.body.id}`).send({ name: 'A', title: 'Neu' });
    expect(u.status).toBe(200);
    expect(u.body.title).toBe('Neu');
  });

  it('DELETE /:id entfernt', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'Weg', title: 'x' });
    const d = await request(app).del(`${BASE}/${c.body.id}`);
    expect(d.status).toBe(200);
    expect(d.body.ok).toBe(true);
    const g = await request(app).get(`${BASE}/${c.body.id}`);
    expect(g.status).toBe(404);
  });

  it('POST /:id/duplicate erzeugt Kopie als Entwurf', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'Quelle', title: 'x', isTemplate: true });
    const dup = await request(app).post(`${BASE}/${c.body.id}/duplicate`).send({});
    expect(dup.status).toBe(201);
    expect(dup.body.name).toBe('Quelle (Kopie)');
    expect(dup.body.isDraft).toBe(true);
    expect(dup.body.id).not.toBe(c.body.id);
  });
});

// ============================================================================
describe('Embed-Router Send', () => {
  it('POST /:id/send ohne Channel -> 400', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S', title: 'x' });
    const r = await request(app).post(`${BASE}/${c.body.id}/send`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Ziel-Channel/);
  });

  it('POST /:id/send leerer Embed -> 400', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S' });
    const r = await request(app).post(`${BASE}/${c.body.id}/send`).send({ channelId: '123456789012345678' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Inhalt/);
  });

  it('POST /:id/send -> postet und speichert messageId', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S', title: 'Hallo', description: 'Welt' });
    const r = await request(app).post(`${BASE}/${c.body.id}/send`).send({ channelId: '123456789012345678' });
    expect(r.status).toBe(200);
    expect(r.body.messageId).toBe('msg-123');
    expect(fakeChannel.send).toHaveBeenCalledTimes(1);

    const g = await request(app).get(`${BASE}/${c.body.id}`);
    expect(g.body.isPosted).toBe(true);
    expect(g.body.isDraft).toBe(false);
  });

  it('POST /:id/send bei fehlendem Bot -> 503', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S', title: 'Hallo' });
    clientEnabled = false;
    const r = await request(app).post(`${BASE}/${c.body.id}/send`).send({ channelId: '123456789012345678' });
    expect(r.status).toBe(503);
  });

  it('POST /:id/sync ohne vorheriges Senden -> 400', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S', title: 'Hallo' });
    const r = await request(app).post(`${BASE}/${c.body.id}/sync`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/noch nicht gesendet/);
  });

  it('POST /:id/sync editiert bestehende Nachricht', async () => {
    const app = makeApp();
    const c = await request(app).post(BASE).send({ name: 'S', title: 'Hallo' });
    await request(app).post(`${BASE}/${c.body.id}/send`).send({ channelId: '123456789012345678' });
    const r = await request(app).post(`${BASE}/${c.body.id}/sync`).send({});
    expect(r.status).toBe(200);
    expect(fakeMessageEdit).toHaveBeenCalled();
  });
});
