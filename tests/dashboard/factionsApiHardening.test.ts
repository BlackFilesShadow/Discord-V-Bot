process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GID = '999999999999999999';
const GID_2 = '111111111111111111';
const MEMBER = '222222222222222222';
const ROLE = '333333333333333333';
const CHANNEL = '444444444444444444';

const txQueryMock = jest.fn<Promise<Array<{ locked: boolean }>>, unknown[]>();
const configUpsertMock = jest.fn().mockResolvedValue({ id: 'cfg-1', guildId: GID });
const transactionMock = jest.fn(async (work: (tx: { $queryRawUnsafe: typeof txQueryMock }) => Promise<unknown>) =>
  work({ $queryRawUnsafe: txQueryMock }));

const prismaMock = {
  factionSystemConfig: { upsert: configUpsertMock },
  $transaction: transactionMock,
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

const validateBotChannelAccessMock = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/utils/discordChannel', () => ({
  __esModule: true,
  validateBotChannelAccess: (...args: unknown[]) => validateBotChannelAccessMock(...args),
}));

const memberFetchMock = jest.fn();
const roleFetchMock = jest.fn();
const permissionsHasMock = jest.fn().mockReturnValue(true);
const guildFetchMock = jest.fn();
const roleCache = new Map<string, { id: string; managed: boolean; position: number }>();
const fakeGuild = {
  id: GID,
  members: {
    fetch: memberFetchMock,
    me: { permissions: { has: permissionsHasMock }, roles: { highest: { position: 100 } } },
  },
  roles: { cache: roleCache, fetch: roleFetchMock },
};
const clientState: { current: null | { guilds: { fetch: typeof guildFetchMock } } } = {
  current: { guilds: { fetch: guildFetchMock } },
};
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => clientState.current,
}));

import express from 'express';
import request from 'supertest';
import {
  factionApiErrorBoundary,
  factionApiPreflight,
  factionMutationLockKeys,
  factionMutationSerialization,
} from '../../src/dashboard/middleware/factionApiHardening';

function scopedApp(...handlers: express.RequestHandler[]) {
  const app = express();
  app.use(express.json());
  app.use('/factions', (req, _res, next) => {
    req.guildScope = { guildId: GID } as NonNullable<express.Request['guildScope']>;
    next();
  }, ...handlers);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  txQueryMock.mockResolvedValue([{ locked: true }]);
  configUpsertMock.mockResolvedValue({ id: 'cfg-1', guildId: GID });
  clientState.current = { guilds: { fetch: guildFetchMock } };
  guildFetchMock.mockImplementation(async (guildId: string) => guildId === GID ? fakeGuild : null);
  memberFetchMock.mockResolvedValue({ id: MEMBER });
  roleFetchMock.mockResolvedValue({ id: ROLE, managed: false, position: 10 });
  roleCache.clear();
  permissionsHasMock.mockReturnValue(true);
  validateBotChannelAccessMock.mockResolvedValue({ ok: true });
});

describe('Faction API preflight validation', () => {
  it('initialisiert system-config atomar per upsert', async () => {
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/factions/system-config');
    expect(res.status).toBe(200);
    expect(configUpsertMock).toHaveBeenCalledWith({
      where: { guildId: GID },
      create: { guildId: GID },
      update: {},
    });
  });

  it('lehnt explizit ungueltige Member-Rollen mit 400 ab statt MEMBER-Fallback', async () => {
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/factions/f1/members').send({ userDiscordId: MEMBER, role: 'OWNER' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/role ungueltig/i);
    expect(guildFetchMock).not.toHaveBeenCalled();
  });

  it('bestaetigt Member-IDs gegen die exakt autorisierte Guild', async () => {
    memberFetchMock.mockResolvedValueOnce(null);
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/factions/f1/members').send({ userDiscordId: MEMBER, role: 'MEMBER' });
    expect(res.status).toBe(400);
    expect(guildFetchMock).toHaveBeenCalledWith(GID);
    expect(memberFetchMock).toHaveBeenCalledWith(MEMBER);
  });

  it('failt Discord-abhaengige Mutationen bei fehlendem Bot geschlossen mit 503', async () => {
    clientState.current = null;
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).patch('/factions/f1').send({ leaderDiscordId: MEMBER });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Bot nicht bereit/i);
  });

  it('lehnt managed oder nicht zuweisbare Guild-Rollen ab', async () => {
    roleCache.set(ROLE, { id: ROLE, managed: true, position: 10 });
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/factions').send({ name: 'Alpha', roleId: ROLE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keine zuweisbare Rolle/i);
  });

  it('lehnt Rollen auf oder oberhalb der Bot-Hierarchie ab', async () => {
    roleCache.set(ROLE, { id: ROLE, managed: false, position: 100 });
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/factions').send({ name: 'Alpha', roleId: ROLE });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hoechsten Bot-Rolle/i);
  });

  it('validiert Embed-Channels mit den Bot-Rechten der exakten Guild', async () => {
    validateBotChannelAccessMock.mockResolvedValueOnce({ ok: false, reason: 'Channel gehoert nicht zur Guild.' });
    const app = scopedApp(factionApiPreflight, (_req, res) => res.json({ ok: true }));
    const res = await request(app).put('/factions/system-config').send({ factionChannelId: CHANNEL });
    expect(res.status).toBe(400);
    expect(validateBotChannelAccessMock).toHaveBeenCalled();
    expect(configUpsertMock).not.toHaveBeenCalled();
  });
});

describe('Faction mutation cross-process race boundary', () => {
  it('laesst Reads ohne DB-Lock passieren', async () => {
    const app = scopedApp(factionMutationSerialization, (_req, res) => res.json({ ok: true }));
    const res = await request(app).get('/factions/f1');
    expect(res.status).toBe(200);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('haelt Multipart-Uploadpfade aus der lang laufenden DB-Transaktion heraus', async () => {
    const app = scopedApp(factionMutationSerialization, (_req, res) => res.json({ ok: true }));
    const res = await request(app).post('/factions/f1/upload');
    expect(res.status).toBe(200);
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('serialisiert schnelle Mutationen per pg_try_advisory_xact_lock', async () => {
    const app = scopedApp(factionMutationSerialization, (_req, res) => res.json({ ok: true }));
    const res = await request(app).patch('/factions/f1').send({ name: 'Beta' });
    expect(res.status).toBe(200);
    const [key1, key2] = factionMutationLockKeys(GID);
    expect(txQueryMock).toHaveBeenCalledWith(
      'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
      key1,
      key2,
    );
  });

  it('gibt bei paralleler Mutation sofort retrybaren 409 statt Pool-Warteschlange', async () => {
    txQueryMock.mockResolvedValueOnce([{ locked: false }]);
    const downstream = jest.fn((_req: express.Request, res: express.Response) => res.json({ ok: true }));
    const app = scopedApp(factionMutationSerialization, downstream);
    const res = await request(app).delete('/factions/f1');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/erneut versuchen/i);
    expect(downstream).not.toHaveBeenCalled();
  });

  it('erzeugt stabile, guild-getrennte Lock-Keys ohne Klartext-ID', () => {
    const a = factionMutationLockKeys(GID);
    const b = factionMutationLockKeys(GID);
    const c = factionMutationLockKeys(GID_2);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.every(Number.isInteger)).toBe(true);
  });
});

describe('Faction Prisma race status boundary', () => {
  function errorApp(code: string) {
    const app = express();
    app.use((_req, _res, next) => next({ code }));
    app.use(factionApiErrorBoundary);
    app.use((_err, _req, res, _next) => res.status(500).json({ error: 'fallback' }));
    return app;
  }

  it('mappt P2025 auf 404', async () => {
    const res = await request(errorApp('P2025')).get('/');
    expect(res.status).toBe(404);
  });

  it.each(['P2002', 'P2003'])('mappt %s auf 409', async code => {
    const res = await request(errorApp(code)).get('/');
    expect(res.status).toBe(409);
  });

  it('reicht unbekannte Fehler an die globale Grenze weiter', async () => {
    const res = await request(errorApp('PX')).get('/');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('fallback');
  });
});
