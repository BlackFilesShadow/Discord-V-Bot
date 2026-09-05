process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import express from 'express';
import request from 'supertest';

const GUILD_ID = '999999999999999999';
const ACTOR_ID = '888888888888888888';
const CONNECTION_ID = 'c123456789012345678901234';
const CHANNEL_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';

type Row = Record<string, unknown>;
const zones = new Map<string, Row>();
let sequence = 0;

interface PrismaMock {
  admEvent: { findFirst: jest.Mock };
  radarConfig: { upsert: jest.Mock };
  radarZone: {
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  radarZonePoint: { deleteMany: jest.Mock; createMany: jest.Mock };
  radarZoneFunction: { deleteMany: jest.Mock; createMany: jest.Mock };
  radarZoneAllowlist: { deleteMany: jest.Mock; createMany: jest.Mock };
  $transaction: <T>(operation: (tx: PrismaMock) => Promise<T>) => Promise<T>;
}

const prismaMock: PrismaMock = {
  admEvent: { findFirst: jest.fn().mockResolvedValue(null) },
  radarConfig: {
    upsert: jest.fn(async ({ create, update }: { create: Row; update: Row }) => ({
      id: 'config-1', guildId: GUILD_ID, nitradoConnId: CONNECTION_ID,
      activeMap: update.activeMap ?? create.activeMap ?? 'CHERNARUS',
    })),
  },
  radarZone: {
    create: jest.fn(async ({ data }: { data: Row }) => {
      sequence += 1;
      const id = `zone-${sequence}`;
      const row = {
        id, ...data, version: 1,
        points: ((data.points as { create: Row[] }).create ?? []).map(point => ({ ...point })),
        functions: ((data.functions as { create: Row[] }).create ?? []).map(entry => ({ ...entry })),
        allowlist: ((data.allowlist as { create: Row[] }).create ?? []).map(entry => ({ ...entry })),
      };
      zones.set(id, row);
      return row;
    }),
    findMany: jest.fn(async ({ where }: { where: Row }) => [...zones.values()].filter(zone => (
      zone.guildId === where.guildId && zone.nitradoConnId === where.nitradoConnId && (!where.map || zone.map === where.map)
    ))),
    findFirst: jest.fn(async ({ where }: { where: Row }) => [...zones.values()].find(zone => (
      zone.id === where.id && zone.guildId === where.guildId && zone.nitradoConnId === where.nitradoConnId
    )) ?? null),
    updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const zone = zones.get(where.id as string);
      if (!zone || zone.guildId !== where.guildId || zone.nitradoConnId !== where.nitradoConnId || zone.version !== where.version) return { count: 0 };
      Object.assign(zone, data, { version: Number(zone.version) + 1 });
      return { count: 1 };
    }),
    deleteMany: jest.fn(async ({ where }: { where: Row }) => {
      const zone = zones.get(where.id as string);
      if (!zone || zone.guildId !== where.guildId || zone.nitradoConnId !== where.nitradoConnId) return { count: 0 };
      zones.delete(where.id as string);
      return { count: 1 };
    }),
  },
  radarZonePoint: { deleteMany: jest.fn(), createMany: jest.fn() },
  radarZoneFunction: { deleteMany: jest.fn(), createMany: jest.fn() },
  radarZoneAllowlist: { deleteMany: jest.fn(), createMany: jest.fn() },
  $transaction: async <T>(operation: (tx: typeof prismaMock) => Promise<T>) => operation(prismaMock),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));
jest.mock('../../src/utils/discordChannel', () => ({ __esModule: true, validateBotChannelAccess: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: () => ({
    guilds: {
      cache: new Map([[GUILD_ID, {
        id: GUILD_ID,
        roles: { cache: new Map([[ROLE_ID, { id: ROLE_ID, managed: false }]]), fetch: jest.fn().mockResolvedValue(null) },
      }]]),
    },
  }),
}));
jest.mock('../../src/dashboard/routes/v2/serverScope', () => ({
  __esModule: true,
  resolveDashboardGameServer: jest.fn().mockResolvedValue({ kind: 'RESOLVED', nitradoConnId: CONNECTION_ID }),
  sendDashboardServerResolutionError: jest.fn(),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (req: { guildScope?: unknown }, _res: unknown, next: () => void) => {
    req.guildScope = { guildId: GUILD_ID, actorDiscordId: ACTOR_ID };
    next();
  },
}));

import { radarRouter } from '../../src/dashboard/routes/v2/radar';

function app(): express.Express {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/guilds/:guildId/radar', radarRouter);
  return instance;
}

const base = `/api/v2/guilds/${GUILD_ID}/radar`;
function body(overrides: Row = {}): Row {
  return {
    name: 'Nordtor', map: 'CHERNARUS', isActive: true,
    geometry: { type: 'POLYGON', points: [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 400 }, { x: 100, y: 400 }] },
    enabledFunctions: ['PLAYER_DETECTION'], allowlist: [{ source: 'MANUAL', gameId: 'abcdef1234567890' }],
    channelId: CHANNEL_ID, rolePingEnabled: true, roleIds: [ROLE_ID], embedColor: '#dc2626',
    ...overrides,
  };
}

beforeEach(() => { zones.clear(); sequence = 0; jest.clearAllMocks(); });

describe('Radar-Router', () => {
  it('liefert die serverseitig aufgeloeste Verbindung und erstellt ein geordnetes Polygon', async () => {
    const instance = app();
    const config = await request(instance).get(`${base}/config?slot=1`);
    expect(config.status).toBe(200);
    expect(config.body).toEqual({ activeMap: 'CHERNARUS', nitradoConnId: CONNECTION_ID });

    const created = await request(instance).post(`${base}/zones?slot=1`).send(body());
    expect(created.status).toBe(201);
    expect(created.body.zone.geometry).toEqual(body().geometry);

    const listed = await request(instance).get(`${base}/zones?slot=1`);
    expect(listed.status).toBe(200);
    expect(listed.body.zones).toHaveLength(1);
    expect(listed.body.zones[0].geometry.points).toEqual((body().geometry as { points: unknown[] }).points);
  });

  it('lehnt fremde IDs, veraltete Versionen und ungueltige GUID- oder Rollenwerte ab', async () => {
    const instance = app();
    const invalid = await request(instance).post(`${base}/zones?slot=1`).send(body({ allowlist: [{ source: 'MANUAL', gameId: 'unknown' }] }));
    expect(invalid.status).toBe(400);
    const invalidRole = await request(instance).post(`${base}/zones?slot=1`).send(body({ roleIds: ['444444444444444444'] }));
    expect(invalidRole.status).toBe(400);

    const created = await request(instance).post(`${base}/zones?slot=1`).send(body());
    expect(created.status).toBe(201);
    const foreign = await request(instance).get(`${base}/zones/foreign-zone?slot=1`);
    expect(foreign.status).toBe(404);
    const stale = await request(instance).put(`${base}/zones/${created.body.zone.id}?slot=1`).send(body({ version: 99 }));
    expect(stale.status).toBe(409);
  });
});