jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    radarConfig: { findMany: jest.fn(), updateMany: jest.fn() },
    radarZone: { findMany: jest.fn(), findFirst: jest.fn() },
    radarZoneEvent: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    admEvent: { findMany: jest.fn() },
    nitradoAdmBindingState: { findUnique: jest.fn() },
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: jest.fn(),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({ __esModule: true, emitRadarEvent: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logger: { error: jest.fn() } }));

import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { emitRadarEvent } from '../../src/dashboard/socket/emitter';
import { runRadarRuntimeOnce } from '../../src/modules/radar/runtime';

const GUILD_ID = '111111111111111111';
const CONN_ID = 'radar-connection-1';
const CHANNEL_ID = '222222222222222222';
const ROLE_ID = '333333333333333333';
const VALID_GUID = 'K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=';
const radarConfigFind = prisma.radarConfig.findMany as jest.Mock;
const radarConfigUpdate = prisma.radarConfig.updateMany as jest.Mock;
const radarZoneFind = prisma.radarZone.findMany as jest.Mock;
const radarZoneFindFirst = prisma.radarZone.findFirst as jest.Mock;
const radarEventCreate = prisma.radarZoneEvent.create as jest.Mock;
const radarEventFind = prisma.radarZoneEvent.findMany as jest.Mock;
const radarEventFindUnique = prisma.radarZoneEvent.findUnique as jest.Mock;
const radarEventUpdate = prisma.radarZoneEvent.updateMany as jest.Mock;
const admEventFind = prisma.admEvent.findMany as jest.Mock;
const dashboardClient = tryGetDashboardClient as jest.Mock;
const realtimeEmit = emitRadarEvent as jest.Mock;

let availableZones: Array<Record<string, any>> = [];

function config() {
  return {
    id: 'radar-config-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    activeMap: 'CHERNARUS',
    cursorCreatedAt: new Date('2026-09-04T10:00:00.000Z'),
    cursorEventId: 'cursor-0',
    createdAt: new Date('2026-09-04T10:00:00.000Z'),
    updatedAt: new Date('2026-09-04T10:00:00.000Z'),
  };
}

function scannedEvent(id = 'adm-event-1', overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventType: 'PLAYER_POSITION',
    occurredAt: new Date('2026-09-04T10:01:00.000Z'),
    createdAt: new Date('2026-09-04T10:01:01.000Z'),
    actorGameId: 'guid-1',
    actorName: 'Player One',
    targetGameId: null,
    targetName: null,
    objectType: null,
    toolOrWeapon: null,
    distanceMeters: null,
    actorPosition: '100, 200, 12',
    targetPosition: null,
    rawLine: 'Player "Player One" (id=guid-1 pos=<100, 200, 12>)',
    ...overrides,
  };
}

function circleZone(overrides: Record<string, unknown> = {}) {
  return {
    id: 'zone-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    channelId: CHANNEL_ID,
    rolePingEnabled: true,
    roleIds: [ROLE_ID],
    shape: 'CIRCLE',
    centerX: 100,
    centerY: 200,
    radiusMeters: 50,
    minX: 50,
    minY: 150,
    maxX: 150,
    maxY: 250,
    updatedAt: new Date('2026-09-04T10:00:10.000Z'),
    points: [],
    functions: [{ functionKey: 'PLAYER_DETECTION' }],
    allowlist: [],
    ...overrides,
  };
}

function pendingRadarEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'radar-event-1',
    zoneId: 'zone-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    channelId: CHANNEL_ID,
    functionKey: 'PLAYER_DETECTION',
    actorName: 'Player One',
    x: 100,
    y: 200,
    altitude: 12,
    admOccurredAt: new Date('2026-09-04T10:01:00.000Z'),
    attempts: 0,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  availableZones = [];
  radarConfigFind.mockResolvedValue([config()]);
  radarConfigUpdate.mockResolvedValue({ count: 1 });
  radarZoneFind.mockImplementation(async ({ where }: { where: Record<string, any> }) => {
    const functionKey = where.functions?.some?.functionKey;
    return availableZones.filter(zone => (
      zone.guildId === where.guildId
      && zone.nitradoConnId === where.nitradoConnId
      && (!where.map || zone.map === undefined || zone.map === where.map)
      && (!functionKey || zone.functions.some((entry: { functionKey: string }) => entry.functionKey === functionKey))
    ));
  });
  radarZoneFindFirst.mockResolvedValue(null);
  radarEventCreate.mockResolvedValue({ id: 'radar-event-1' });
  radarEventFind.mockResolvedValue([]);
  radarEventFindUnique.mockResolvedValue(null);
  radarEventUpdate.mockResolvedValue({ count: 1 });
  admEventFind.mockResolvedValue([]);
  dashboardClient.mockReturnValue(null);
});

describe('Radar-Worker', () => {
  it('wertet nur Zonen der aktiven Karte aus und ueberspringt die GUID-Allowlist', async () => {
    admEventFind.mockResolvedValue([scannedEvent()]);
    availableZones = [circleZone({ allowlist: [{ gameId: 'guid-1' }] })];

    await runRadarRuntimeOnce();

    expect(radarZoneFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ map: 'CHERNARUS', guildId: GUILD_ID, nitradoConnId: CONN_ID }),
    }));
    expect(radarEventCreate).not.toHaveBeenCalled();
  });

  it('persistiert ueberlappende passende Zonen dedupliziert und emittiert das gespeicherte X/Z-Ereignis', async () => {
    const event = scannedEvent();
    admEventFind.mockResolvedValue([event]);
    availableZones = [circleZone(), circleZone({ id: 'zone-2' })];
    radarEventCreate
      .mockResolvedValueOnce({ id: 'radar-event-1' })
      .mockRejectedValueOnce({ code: 'P2002' });
    radarEventFindUnique.mockResolvedValue({
      id: 'radar-event-1',
      zoneId: 'zone-1',
      guildId: GUILD_ID,
      nitradoConnId: CONN_ID,
      functionKey: 'PLAYER_DETECTION',
      actorName: 'Player One',
      x: 100,
      y: 200,
      altitude: 12,
      admOccurredAt: event.occurredAt,
    });

    await runRadarRuntimeOnce();

    expect(radarEventCreate).toHaveBeenCalledTimes(2);
    expect(realtimeEmit).toHaveBeenCalledWith(expect.objectContaining({
      radarEventId: 'radar-event-1', functionKey: 'PLAYER_DETECTION', x: 100, y: 200,
    }));
  });

  it('erzeugt bei Spieler-Erkennung plus Bann-Spieler-Erkennung nur das punitive kanonische Ereignis', async () => {
    admEventFind.mockResolvedValue([scannedEvent('adm-ban-player', { actorGameId: VALID_GUID })]);
    availableZones = [circleZone({
      functions: [{ functionKey: 'PLAYER_DETECTION' }, { functionKey: 'BAN_PLAYER_DETECTION' }],
    })];

    await runRadarRuntimeOnce();

    expect(radarEventCreate).toHaveBeenCalledTimes(1);
    expect(radarEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ functionKey: 'BAN_PLAYER_DETECTION', actorGameId: VALID_GUID }),
    }));
  });

  it('interpretiert einen verspaeteten ADM-Event nie gegen eine spaeter gespeicherte Zonen-Generation', async () => {
    admEventFind.mockResolvedValue([scannedEvent('adm-delayed', {
      occurredAt: new Date('2026-09-04T10:01:00.000Z'),
      createdAt: new Date('2026-09-04T10:03:00.000Z'),
    })]);
    availableZones = [circleZone({ updatedAt: new Date('2026-09-04T10:02:00.000Z') })];

    await runRadarRuntimeOnce();

    expect(radarEventCreate).not.toHaveBeenCalled();
  });

  it('verwendet ADM-Hoehe als gespeicherte Evidenz, aber nicht als unsichtbares konfigurierbares Zonenband', async () => {
    admEventFind.mockResolvedValue([scannedEvent('adm-height', { actorPosition: '100, 200, 215.7' })]);
    availableZones = [circleZone({
      altitudeEnabled: true,
      minAltitudeMeters: 999,
      maxAltitudeMeters: 1000,
    })];

    await runRadarRuntimeOnce();

    expect(radarEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ x: 100, y: 200, altitude: 215.7 }),
    }));
  });

  it('matched reale Chernarus-X/Z-Koordinaten gegen die gespeicherte Produktionszone', async () => {
    const event = scannedEvent('adm-production-1', {
      actorName: 'Oo_KirscHi_oO',
      actorGameId: 'bNlNN_3Pu14USUjUdElHfo-HzSPmpZtIGndfOqCo2l8=',
      actorPosition: '7808.7, 5138.3, 215.7',
    });
    admEventFind.mockResolvedValue([event]);
    availableZones = [circleZone({
      id: 'prod-zone-test1',
      centerX: 5287.122,
      centerY: 5893.028,
      radiusMeters: 4774,
      minX: 513.122,
      minY: 1119.028,
      maxX: 10061.122,
      maxY: 10667.028,
    })];

    await runRadarRuntimeOnce();

    expect(radarEventCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        zoneId: 'prod-zone-test1',
        admEventId: 'adm-production-1',
        functionKey: 'PLAYER_DETECTION',
        x: 7808.7,
        y: 5138.3,
        altitude: 215.7,
      }),
    }));
  });

  it('stoppt den Scan bei verlorenem Cursor-Compare-and-Swap ohne die Lieferung zu starten', async () => {
    admEventFind.mockResolvedValue([scannedEvent()]);
    radarConfigUpdate.mockResolvedValue({ count: 0 });

    await runRadarRuntimeOnce();

    expect(admEventFind).toHaveBeenCalledTimes(1);
    expect(radarEventFind).not.toHaveBeenCalled();
  });

  it('sendet kontrollierte Rollenmentions, nur X/Z plus iZurvive und niemals ADM-Hoehe', async () => {
    const send = jest.fn().mockResolvedValue({ id: 'discord-message-1' });
    dashboardClient.mockReturnValue({
      channels: {
        fetch: jest.fn().mockResolvedValue({
          guildId: GUILD_ID,
          isTextBased: () => true,
          isDMBased: () => false,
          send,
        }),
      },
    });
    radarEventFind.mockResolvedValue([pendingRadarEvent()]);
    radarZoneFindFirst.mockResolvedValue({
      name: 'Nordbasis',
      map: 'CHERNARUS',
      channelId: CHANNEL_ID,
      rolePingEnabled: true,
      roleIds: [ROLE_ID, ROLE_ID],
      embedColor: '#dc2626',
    });

    await runRadarRuntimeOnce();

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: `<@&${ROLE_ID}>`,
      allowedMentions: { parse: [], roles: [ROLE_ID] },
      enforceNonce: true,
    }));
    const fields = send.mock.calls[0][0].embeds[0].toJSON().fields as Array<{ name: string; value: string }>;
    expect(fields.map(field => field.name)).toEqual(expect.arrayContaining([
      'Username', 'Koordinaten X/Z', 'Erkannt durch ADM',
    ]));
    expect(fields.map(field => field.name)).not.toContain('ADM-Hoehe');
    expect(fields.find(field => field.name === 'Koordinaten X/Z')?.value)
      .toBe('[X: 100.0 · Z: 200.0](https://www.izurvive.com/chernarusplus/#location=100;200;6)');
    expect(radarEventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'radar-event-1', status: 'SENDING' }),
      data: expect.objectContaining({ status: 'SENT', messageId: 'discord-message-1' }),
    }));
  });

  it('begrenzt abgelaufene Leases und macht einen nicht erreichbaren Channel retrybar', async () => {
    radarConfigFind.mockResolvedValue([]);
    await runRadarRuntimeOnce();
    expect(radarEventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'SENDING', attempts: { gte: 7 } }),
      data: expect.objectContaining({ status: 'FAILED', attempts: { increment: 1 } }),
    }));

    radarConfigFind.mockResolvedValue([config()]);
    radarEventFind.mockResolvedValue([pendingRadarEvent()]);
    dashboardClient.mockReturnValue({ channels: { fetch: jest.fn().mockResolvedValue(null) } });
    radarZoneFindFirst.mockResolvedValue({
      name: 'Nordbasis', map: 'CHERNARUS', channelId: CHANNEL_ID,
      rolePingEnabled: false, roleIds: [], embedColor: '#dc2626',
    });
    await runRadarRuntimeOnce();

    expect(radarEventUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'radar-event-1', status: 'SENDING' }),
      data: expect.objectContaining({ status: 'RETRY', attempts: 1, leaseUntil: null }),
    }));
  });
});
