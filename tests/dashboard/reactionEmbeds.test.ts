// Minimal nötige ENV-Variablen für config.ts (defensiv).
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Reaktions-Embeds (Dashboard-only): Router-CRUD, Optionen, Rollen-Schutz,
 * send/archive. Nutzt In-Memory-Prisma-Mock + Fake-Discord-Client.
 *
 * Sicherheits-Fokus:
 *   - @everyone niemals als Reaktionsrolle
 *   - managed-Rollen abgelehnt
 *   - Bot-Hierarchie (Rolle darf nicht ueber der Bot-Rolle liegen)
 *   - strikte guildId-Scope-Trennung
 */

const GID = '999999999999999999';
const OTHER_GID = '111111111111111111';
const ACTOR = '888888888888888888';
const CH = '222222222222222222';
const ROLE_LOW = '333333333333333301';
const ROLE_HIGH = '333333333333333302';
const ROLE_MANAGED = '333333333333333303';

// ── In-Memory Prisma-Store ──────────────────────────────────────────────────
interface Row { id: string; [k: string]: unknown }
const menus = new Map<string, Row>();
const options = new Map<string, Row>();
const embeds = new Map<string, Row>();
let seq = 0;

function matchWhere(r: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => v === undefined || r[k] === v);
}

const prismaMock = {
  selfRoleMenu: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const row: Row = { id: `m${seq}`, messageId: null, isActive: true, archived: false, createdAt: new Date(), updatedAt: new Date(), ...data };
      menus.set(row.id, row);
      return row;
    }),
    findFirst: jest.fn(async ({ where, include }: { where: Record<string, unknown>; include?: unknown }) => {
      const row = [...menus.values()].find(r => matchWhere(r, where)) ?? null;
      return row && include ? withOptions(row) : row;
    }),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...menus.values()].filter(r => matchWhere(r, where)).map(withOptions),
    ),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = [...menus.values()].find(x => matchWhere(x, where));
      if (r) { Object.assign(r, data); return { count: 1 }; }
      return { count: 0 };
    }),
    update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = menus.get(where.id as string)!;
      Object.assign(r, data);
      return r;
    }),
    delete: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = menus.get(where.id as string)!;
      menus.delete(where.id as string);
      return r;
    }),
  },
  selfRoleOption: {
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const dupe = [...options.values()].find(o => o.menuId === data.menuId && o.roleId === data.roleId);
      if (dupe) { const e = new Error('unique') as Error & { code: string }; e.code = 'P2002'; throw e; }
      seq += 1;
      const row: Row = { id: `o${seq}`, isActive: true, buttonStyle: 'SECONDARY', ...data };
      options.set(row.id, row);
      return row;
    }),
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...options.values()].filter(o => matchWhere(o, where)).length,
    ),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...options.values()].find(o => matchWhere(o, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...options.values()].filter(o => matchWhere(o, where)),
    ),
    update: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const r = options.get(where.id as string)!;
      Object.assign(r, data);
      return r;
    }),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const toDel = [...options.values()].filter(o => matchWhere(o, where));
      toDel.forEach(o => options.delete(o.id));
      return { count: toDel.length };
    }),
  },
  dashboardEmbed: {
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      [...embeds.values()].find(e => matchWhere(e, where)) ?? null,
    ),
  },
  $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
};

function withOptions(menu: Row): Row {
  return { ...menu, options: [...options.values()].filter(o => o.menuId === menu.id).sort((a, b) => (a.position as number) - (b.position as number)) };
}

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

// selfRoleMenu-Modul (getMenuFull/publishMenu) fuer den Send-Pfad mocken.
const publishMenuMock = jest.fn().mockResolvedValue('msg-777');
const getMenuFullMock = jest.fn();
jest.mock('../../src/modules/selfrole/selfRoleMenu', () => ({
  __esModule: true,
  getMenuFull: (id: string) => getMenuFullMock(id),
  publishMenu: (...a: unknown[]) => publishMenuMock(...a),
}));

// Fake Discord-Client mit Guild + Rollen-Hierarchie.
function makeRole(id: string, position: number, managed: boolean) {
  return { id, position, managed };
}
const roleCache = new Map<string, unknown>([
  [ROLE_LOW, makeRole(ROLE_LOW, 1, false)],
  [ROLE_HIGH, makeRole(ROLE_HIGH, 100, false)],
  [ROLE_MANAGED, makeRole(ROLE_MANAGED, 2, true)],
]);
const textChannel = { isTextBased: () => true, isDMBased: () => false, messages: { delete: jest.fn().mockResolvedValue({}) } };
const guild = {
  id: GID,
  roles: { cache: roleCache, fetch: async (id: string) => roleCache.get(id) ?? null },
  members: { me: { roles: { highest: { position: 50 } }, permissions: { has: () => true } } },
  channels: { cache: new Map([[CH, textChannel]]) },
};
const fakeClient = {
  guilds: { cache: new Map([[GID, guild]]) },
  channels: { cache: new Map([[CH, textChannel]]), fetch: async (id: string) => (id === CH ? textChannel : null) },
};
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => fakeClient,
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
    req.guildScope = { guildId: GID, actorDiscordId: ACTOR, permissions: ['reactionroles.manage'] };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { reactionEmbedsRouter } from '../../src/dashboard/routes/v2/reactionEmbeds';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2/guilds/:guildId/reaction-embeds', reactionEmbedsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _n: express.NextFunction) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

const BASE = `/api/v2/guilds/${GID}/reaction-embeds`;

beforeEach(() => {
  jest.clearAllMocks();
  menus.clear();
  options.clear();
  embeds.clear();
  seq = 0;
  publishMenuMock.mockResolvedValue('msg-777');
});

async function createMenu(app: express.Express, body: Record<string, unknown> = {}) {
  return request(app).post(BASE).send({ title: 'Rollen', channelId: CH, componentType: 'BUTTON', ...body });
}

// ============================================================================
describe('Reaktions-Embeds Router — Menu-CRUD', () => {
  it('erstellt ein Menu mit Defaults', async () => {
    const app = makeApp();
    const res = await createMenu(app);
    expect(res.status).toBe(201);
    expect(res.body.componentType).toBe('BUTTON');
    expect(res.body.assignMode).toBe('TOGGLE');
    expect(res.body.mode).toBe('MULTI');
  });

  it('lehnt fehlenden Titel ab', async () => {
    const app = makeApp();
    const res = await request(app).post(BASE).send({ channelId: CH });
    expect(res.status).toBe(400);
  });

  it('lehnt ungültige channelId ab', async () => {
    const app = makeApp();
    const res = await request(app).post(BASE).send({ title: 'X', channelId: 'nope' });
    expect(res.status).toBe(400);
  });

  it('lehnt maxRolesPerUser ausserhalb 1..25 ab', async () => {
    const app = makeApp();
    const res = await createMenu(app, { maxRolesPerUser: 99 });
    expect(res.status).toBe(400);
  });

  it('listet nur Menus der eigenen Guild', async () => {
    const app = makeApp();
    await createMenu(app);
    menus.set('foreign', { id: 'foreign', guildId: OTHER_GID, channelId: CH, title: 'Fremd', options: [] });
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.menus).toHaveLength(1);
  });

  it('aktualisiert und löscht ein Menu', async () => {
    const app = makeApp();
    const created = await createMenu(app);
    const id = created.body.id;
    const upd = await request(app).put(`${BASE}/${id}`).send({ title: 'Neu', channelId: CH, assignMode: 'GIVE' });
    expect(upd.status).toBe(200);
    expect(upd.body.assignMode).toBe('GIVE');
    const del = await request(app).delete(`${BASE}/${id}`);
    expect(del.status).toBe(200);
    expect(menus.has(id)).toBe(false);
  });

  it('verweigert Verknüpfung mit fremdem Embed', async () => {
    const app = makeApp();
    embeds.set('e-foreign', { id: 'e-foreign', guildId: OTHER_GID });
    const res = await createMenu(app, { embedId: 'e-foreign' });
    expect(res.status).toBe(400);
  });
});

// ============================================================================
describe('Reaktions-Embeds Router — Optionen & Rollen-Schutz', () => {
  it('fügt eine gültige Rollen-Option hinzu', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const res = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_LOW, label: 'Gamer', buttonStyle: 'SUCCESS' });
    expect(res.status).toBe(201);
    expect(res.body.buttonStyle).toBe('SUCCESS');
  });

  it('lehnt @everyone (guildId) als Rolle ab', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const res = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: GID, label: 'Nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/everyone/i);
  });

  it('lehnt managed-Rollen ab', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const res = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_MANAGED, label: 'Bot' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Integration/i);
  });

  it('lehnt Rollen oberhalb der Bot-Rolle ab (Hierarchie)', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const res = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_HIGH, label: 'Zu hoch' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hoch/i);
  });

  it('verhindert doppelte Rolle im selben Menu (409)', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_LOW, label: 'A' });
    const res = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_LOW, label: 'B' });
    expect(res.status).toBe(409);
  });

  it('aktualisiert und entfernt Optionen', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const opt = await request(app).post(`${BASE}/${m.body.id}/options`).send({ roleId: ROLE_LOW, label: 'A' });
    const upd = await request(app).put(`${BASE}/${m.body.id}/options/${opt.body.id}`).send({ label: 'B', isActive: false });
    expect(upd.status).toBe(200);
    expect(upd.body.isActive).toBe(false);
    const del = await request(app).delete(`${BASE}/${m.body.id}/options/${opt.body.id}`);
    expect(del.status).toBe(200);
    expect(options.size).toBe(0);
  });
});

// ============================================================================
describe('Reaktions-Embeds Router — send / archive', () => {
  it('sendet ein Menu mit aktiven Optionen', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    getMenuFullMock.mockResolvedValueOnce({
      id: m.body.id, guildId: GID, channelId: CH, componentType: 'BUTTON',
      options: [{ roleId: ROLE_LOW, isActive: true, emoji: null }],
    });
    const res = await request(app).post(`${BASE}/${m.body.id}/send`).send({});
    expect(res.status).toBe(200);
    expect(res.body.messageId).toBe('msg-777');
    expect(publishMenuMock).toHaveBeenCalled();
  });

  it('lehnt send ohne aktive Optionen ab', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    getMenuFullMock.mockResolvedValueOnce({ id: m.body.id, guildId: GID, channelId: CH, componentType: 'BUTTON', options: [] });
    const res = await request(app).post(`${BASE}/${m.body.id}/send`).send({});
    expect(res.status).toBe(400);
  });

  it('verlangt Emoji fuer REACTION-Menus', async () => {
    const app = makeApp();
    const m = await createMenu(app, { componentType: 'REACTION' });
    getMenuFullMock.mockResolvedValueOnce({
      id: m.body.id, guildId: GID, channelId: CH, componentType: 'REACTION',
      options: [{ roleId: ROLE_LOW, isActive: true, emoji: null }],
    });
    const res = await request(app).post(`${BASE}/${m.body.id}/send`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Emoji/i);
  });

  it('archiviert und reaktiviert ein Menu', async () => {
    const app = makeApp();
    const m = await createMenu(app);
    const arch = await request(app).post(`${BASE}/${m.body.id}/archive`).send({ archived: true });
    expect(arch.status).toBe(200);
    expect(arch.body.archived).toBe(true);
    expect(arch.body.isActive).toBe(false);
    const re = await request(app).post(`${BASE}/${m.body.id}/archive`).send({ archived: false });
    expect(re.body.archived).toBe(false);
  });
});
