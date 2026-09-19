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
const CONFIG_ID = 'feed-config-1';

// Regression (FIX-6): ein Feed, der frueher einmal Nitrado-auto-pausiert war
// (autoPausedReason gesetzt), behaelt diesen Marker bisher auch nach einer
// voellig unabhaengigen, spaeteren expliziten Admin-Aktion (isActive an ODER
// aus). resumeAutoPausedGameplayFeeds() erkennt dann eine ganz normale
// manuelle Pause faelschlich als "von Nitrado auto-pausiert" und schaltet sie
// beim naechsten gesunden ADM-Sync automatisch wieder ein.
let existingRow: Record<string, unknown>;
const updateManyMock = jest.fn(async (args: { data: Record<string, unknown> }) => {
  existingRow = { ...existingRow, ...args.data };
  return { count: 1 };
});
const findFirstMock = jest.fn(async () => existingRow);
const queryRawMock = jest.fn(async () => [{ id: CONFIG_ID, isActive: existingRow.isActive }]);
const admEventFindFirstMock = jest.fn(async () => null);
const flagEventFindFirstMock = jest.fn(async () => null);

interface PrismaMock {
  gameplayFeedConfig: { findFirst: typeof findFirstMock; updateMany: typeof updateManyMock };
  admEvent: { findFirst: typeof admEventFindFirstMock };
  flagActivityEvent: { findFirst: typeof flagEventFindFirstMock };
  $queryRaw: typeof queryRawMock;
  $transaction: <T>(fn: (tx: PrismaMock) => Promise<T>) => Promise<T>;
}

const prismaMock: PrismaMock = {
  gameplayFeedConfig: { findFirst: findFirstMock, updateMany: updateManyMock },
  admEvent: { findFirst: admEventFindFirstMock },
  flagActivityEvent: { findFirst: flagEventFindFirstMock },
  $queryRaw: queryRawMock,
  $transaction: async (fn) => fn(prismaMock),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitGuildEvent: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAuditDb: jest.fn(),
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: jest.fn(() => null),
}));
jest.mock('../../src/dashboard/routes/v2/serverScope', () => ({
  __esModule: true,
  resolveDashboardGameServer: jest.fn().mockResolvedValue({ kind: 'RESOLVED', nitradoConnId: CONNECTION_ID }),
  sendDashboardServerResolutionError: jest.fn(),
}));
jest.mock('../../src/dashboard/middleware/auth', () => ({
  __esModule: true,
  requireGuildPermission: () => (req: { guildScope?: unknown; auth?: unknown }, _res: unknown, next: () => void) => {
    req.guildScope = { guildId: GUILD_ID, actorDiscordId: ACTOR_ID };
    req.auth = { userId: ACTOR_ID };
    next();
  },
}));

import { killfeedRouter } from '../../src/dashboard/routes/v2/killfeed';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/killfeed', killfeedRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  existingRow = {
    id: CONFIG_ID,
    guildId: GUILD_ID,
    nitradoConnId: CONNECTION_ID,
    kind: 'DEATH',
    channelId: '111111111111111111',
    isActive: false,
    // Marker aus einer laengst vergangenen Nitrado-Auto-Pause, die durch ein
    // fruehes manuelles Wiedereinschalten stehen geblieben ist.
    autoPausedReason: 'NITRADO_INACTIVE',
    autoPausedAt: new Date('2026-01-01T00:00:00Z'),
  };
});

describe('killfeed PATCH clears stale auto-pause marker on explicit admin toggle', () => {
  it('raeumt den Marker auf, wenn ein Admin den Feed explizit wieder aktiviert', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/killfeed/${CONFIG_ID}?kind=DEATH`)
      .send({ isActive: true });

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const data = updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.autoPausedReason).toBeNull();
    expect(data.autoPausedAt).toBeNull();
  });

  it('raeumt den Marker auch auf, wenn ein Admin den Feed explizit (erneut/unabhaengig) deaktiviert', async () => {
    existingRow.isActive = true;
    existingRow.autoPausedReason = null;
    existingRow.autoPausedAt = null;
    // Feed war frueher schon einmal auto-pausiert; der Marker haengt trotz
    // zwischenzeitlicher Reaktivierung noch von einem aelteren Zyklus.
    existingRow.autoPausedReason = 'NITRADO_INACTIVE';
    existingRow.autoPausedAt = new Date('2026-01-01T00:00:00Z');

    const app = makeApp();
    const res = await request(app)
      .patch(`/killfeed/${CONFIG_ID}?kind=DEATH`)
      .send({ isActive: false });

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const data = updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.isActive).toBe(false);
    expect(data.autoPausedReason).toBeNull();
    expect(data.autoPausedAt).toBeNull();
  });

  it('laesst den Marker unangetastet, wenn isActive gar nicht Teil des Updates ist', async () => {
    const app = makeApp();
    const res = await request(app)
      .patch(`/killfeed/${CONFIG_ID}?kind=DEATH`)
      .send({ showTool: true });

    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const data = updateManyMock.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty('autoPausedReason');
    expect(data).not.toHaveProperty('autoPausedAt');
  });
});
