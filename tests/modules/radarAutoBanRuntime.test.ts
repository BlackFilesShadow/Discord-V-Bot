process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUID = 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=';
const GUILD_ID = '999999999999999999';
const CONN_ID = 'conn-radar-auto-ban';
const ACTOR_ID = '888888888888888888';
const ARMED_AT = new Date('2026-09-06T00:00:00.000Z');
const OCCURRED_AT = new Date('2026-09-06T00:01:00.000Z');
const CREATED_AT = new Date('2026-09-06T00:01:01.000Z');

type AnyRow = Record<string, any>;

const rootUpdateMany = jest.fn();
const rootFindFirst = jest.fn();
const txUpdateMany = jest.fn();
const txFindUnique = jest.fn();
const zoneFindFirst = jest.fn();
const configFindUnique = jest.fn();
const admFindFirst = jest.fn();
const bindingFindUnique = jest.fn();
const banFindUnique = jest.fn();
const whitelistUpdateMany = jest.fn();
const whitelistRequestUpdateMany = jest.fn();
const fenceUpsert = jest.fn();
const queryRaw = jest.fn();

const tx = {
  radarZoneEvent: { findUnique: txFindUnique, updateMany: txUpdateMany },
  radarZone: { findFirst: zoneFindFirst },
  radarConfig: { findUnique: configFindUnique },
  admEvent: { findFirst: admFindFirst },
  nitradoAdmBindingState: { findUnique: bindingFindUnique },
  radarAutoBanBanFence: { upsert: fenceUpsert },
  serverBanEntry: { findUnique: banFindUnique },
  whitelistEntry: { updateMany: whitelistUpdateMany },
  whitelistRequest: { updateMany: whitelistRequestUpdateMany },
  $queryRawUnsafe: queryRaw,
};

const prismaMock = {
  radarZoneEvent: { updateMany: rootUpdateMany, findFirst: rootFindFirst },
  $transaction: jest.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

const addBan = jest.fn();
const enqueueServerBanAdd = jest.fn();
const logAudit = jest.fn();
jest.mock('../../src/modules/bans/banRegistry', () => ({
  __esModule: true,
  addBan: (...args: unknown[]) => addBan(...args),
  isBanActive: (entry: { active: boolean; expiresAt: Date | null } | null, now: Date) => Boolean(entry?.active && (!entry.expiresAt || entry.expiresAt > now)),
}));
jest.mock('../../src/modules/bans/banOutbox', () => ({ __esModule: true, enqueueServerBanAdd: (...args: unknown[]) => enqueueServerBanAdd(...args) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logAudit: (...args: unknown[]) => logAudit(...args), logger: { info: jest.fn(), error: jest.fn() } }));

import { RadarAutoBanStatus } from '@prisma/client';
import { runRadarAutoBanOnce } from '../../src/modules/radar/autoBanRuntime';

function event(overrides: AnyRow = {}): AnyRow {
  return {
    id: 'radar-event-1',
    zoneId: 'zone-1',
    admEventId: 'adm-event-1',
    functionKey: 'PLAYER_DETECTION',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    admEventType: 'PLAYER_POSITION',
    actorGameId: GUID,
    actorName: 'Player One',
    x: 100,
    y: 100,
    admOccurredAt: OCCURRED_AT,
    zoneVersionSnapshot: 1,
    zoneMapSnapshot: 'CHERNARUS',
    zoneGeometrySnapshot: { shape: 'CIRCLE', centerX: 100, centerY: 100, radiusMeters: 100, minX: 0, minY: 0, maxX: 200, maxY: 200 },
    zoneFunctionsSnapshot: ['PLAYER_DETECTION'],
    zoneAllowlistSnapshot: [],
    autoBanEnabledSnapshot: true,
    autoBanEnabledAtSnapshot: ARMED_AT,
    autoBanAuthorizedBy: ACTOR_ID,
    autoBanStatus: RadarAutoBanStatus.PROCESSING,
    autoBanAttempts: 0,
    ...overrides,
  };
}

function zone(overrides: AnyRow = {}): AnyRow {
  return {
    id: 'zone-1', configId: 'config-1', guildId: GUILD_ID, nitradoConnId: CONN_ID,
    name: 'Nordbasis', map: 'CHERNARUS', shape: 'CIRCLE', isActive: true,
    autoBanEnabled: true, autoBanEnabledAt: ARMED_AT, autoBanAuthorizedBy: ACTOR_ID, version: 1,
    centerX: 100, centerY: 100, radiusMeters: 100, minX: 0, minY: 0, maxX: 200, maxY: 200,
    points: [], functions: [{ functionKey: 'PLAYER_DETECTION' }], allowlist: [],
    ...overrides,
  };
}

function adm(overrides: AnyRow = {}): AnyRow {
  return {
    id: 'adm-event-1', sourceFile: 'DayZServer_PS4_x64_2026-09-06_00-00-00.ADM',
    eventType: 'PLAYER_POSITION', occurredAt: OCCURRED_AT, createdAt: CREATED_AT,
    actorGameId: GUID, actorName: 'Player One', targetGameId: null, targetName: null,
    objectType: null, toolOrWeapon: null, distanceMeters: null,
    actorPosition: '100, 100, 12', targetPosition: null,
    ...overrides,
  };
}

function queueOne(row: AnyRow): void {
  rootFindFirst
    .mockResolvedValueOnce({ id: row.id, autoBanAttempts: row.autoBanAttempts ?? 0 })
    .mockResolvedValueOnce(null);
  txFindUnique.mockResolvedValue(row);
}

beforeEach(() => {
  jest.clearAllMocks();
  rootUpdateMany.mockResolvedValue({ count: 1 });
  txUpdateMany.mockResolvedValue({ count: 1 });
  fenceUpsert.mockResolvedValue({});
  queryRaw.mockResolvedValue([{ pg_advisory_xact_lock: null }]);
  zoneFindFirst.mockResolvedValue(zone());
  configFindUnique.mockResolvedValue({ activeMap: 'CHERNARUS' });
  admFindFirst.mockResolvedValue(adm());
  bindingFindUnique.mockResolvedValue({ bindingVersion: 0, currentServiceId: 'service-1' });
  banFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'ban-1' });
  whitelistUpdateMany.mockResolvedValue({ count: 0 });
  whitelistRequestUpdateMany.mockResolvedValue({ count: 0 });
  addBan.mockResolvedValue(undefined);
  enqueueServerBanAdd.mockResolvedValue(true);
});

async function expectSkipped(row: AnyRow, code: string): Promise<void> {
  queueOne(row);
  await runRadarAutoBanOnce();
  expect(addBan).not.toHaveBeenCalled();
  expect(fenceUpsert).not.toHaveBeenCalled();
  expect(enqueueServerBanAdd).not.toHaveBeenCalled();
  expect(txUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
    where: expect.objectContaining({ id: row.id, autoBanStatus: RadarAutoBanStatus.PROCESSING }),
    data: expect.objectContaining({ autoBanStatus: RadarAutoBanStatus.SKIPPED, autoBanLastError: code }),
  }));
}

describe('Radar Auto-Ban Runtime', () => {
  it('bannt nur einen vollständig revalidierten Event und fenced ihn vor dem Outbox-Enqueue auf exakt dieselbe Nitrado-Generation', async () => {
    const row = event();
    queueOne(row);

    await runRadarAutoBanOnce();

    expect(addBan).toHaveBeenCalledTimes(1);
    expect(addBan).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: GUILD_ID, nitradoConnId: CONN_ID },
      expect.objectContaining({ gameLabel: 'Player One', bannedByDiscordId: ACTOR_ID, expiresAt: null }),
      expect.any(Date),
    );
    expect(fenceUpsert).toHaveBeenCalledWith({
      where: { banId: 'ban-1' },
      create: {
        banId: 'ban-1',
        radarEventId: 'radar-event-1',
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        serviceId: 'service-1',
        bindingVersion: 0,
        invalidatedAt: null,
      },
      update: {
        radarEventId: 'radar-event-1',
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        serviceId: 'service-1',
        bindingVersion: 0,
        invalidatedAt: null,
      },
    });
    expect(enqueueServerBanAdd).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: GUILD_ID, nitradoConnId: CONN_ID },
      'ban-1',
      GUID,
      expect.any(String),
    );
    expect(addBan.mock.invocationCallOrder[0]).toBeLessThan(fenceUpsert.mock.invocationCallOrder[0]);
    expect(fenceUpsert.mock.invocationCallOrder[0]).toBeLessThan(enqueueServerBanAdd.mock.invocationCallOrder[0]);
    expect(txUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ autoBanStatus: RadarAutoBanStatus.APPLIED, autoBanBanId: 'ban-1' }),
    }));
    expect(logAudit).toHaveBeenCalledWith('RADAR_AUTO_BAN_APPLIED', 'MODERATION', expect.not.objectContaining({ identifier: GUID }));
  });

  it('bannt nie innerhalb des 10m-Grenzsicherheitsbereichs', async () => {
    await expectSkipped(event({ x: 195, zoneGeometrySnapshot: { shape: 'CIRCLE', centerX: 100, centerY: 100, radiusMeters: 100 } }), 'BOUNDARY_SAFETY_MARGIN');
  });

  it('bannt nie bei geänderter Zonen-Version', async () => {
    zoneFindFirst.mockResolvedValue(zone({ version: 2 }));
    await expectSkipped(event(), 'ZONE_VERSION_CHANGED');
  });

  it('bannt nie wenn sich die Auto-Ban-Aktivierungsidentität geändert hat', async () => {
    zoneFindFirst.mockResolvedValue(zone({ autoBanAuthorizedBy: '777777777777777777' }));
    await expectSkipped(event(), 'AUTOBAN_AUTHORIZER_CHANGED');
  });

  it('bannt nie bei falscher Eventtyp-/Toggle-Zuordnung', async () => {
    admFindFirst.mockResolvedValue(adm({ eventType: 'BUILD' }));
    await expectSkipped(event(), 'ADM_EVENT_TYPE_CHANGED');
  });

  it('bannt nie einen aktuell oder zum Snapshot allowlisteten Spieler', async () => {
    zoneFindFirst.mockResolvedValue(zone({ allowlist: [{ gameId: GUID }] }));
    await expectSkipped(event(), 'ACTOR_ALLOWLISTED');
  });

  it('bannt nie einen Event aus einer alten ADM-Binding-Generation', async () => {
    bindingFindUnique.mockResolvedValue({ bindingVersion: 2, currentServiceId: 'service-new' });
    await expectSkipped(event(), 'ADM_BINDING_GENERATION_MISMATCH');
  });

  it('bannt nie ein altes ADM-Ereignis nur weil es verspätet nach dem Arming ingestiert wurde', async () => {
    const oldOccurrence = new Date('2026-09-05T23:59:59.000Z');
    await expectSkipped(event({ admOccurredAt: oldOccurrence }), 'ADM_EVENT_PREDATES_AUTOBAN_ARM');
  });

  it('bannt nie einen ADM-Zeitpunkt in der Zukunft', async () => {
    await expectSkipped(event({ admOccurredAt: new Date('2099-01-01T00:00:00.000Z') }), 'ADM_TIME_IN_FUTURE');
  });

  it('reaktiviert einen bereits aktiven Ban nicht erneut, schreibt keinen Radar-Fence und erzeugt keinen zweiten Outbox-Intent', async () => {
    banFindUnique.mockReset();
    banFindUnique.mockResolvedValue({ id: 'existing-ban', active: true, expiresAt: null });
    const row = event();
    queueOne(row);

    await runRadarAutoBanOnce();

    expect(addBan).not.toHaveBeenCalled();
    expect(fenceUpsert).not.toHaveBeenCalled();
    expect(enqueueServerBanAdd).not.toHaveBeenCalled();
    expect(txUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ autoBanStatus: RadarAutoBanStatus.APPLIED, autoBanBanId: 'existing-ban', autoBanLastError: 'ALREADY_ACTIVE_BAN' }),
    }));
  });
});
