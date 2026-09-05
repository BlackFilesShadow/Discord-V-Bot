jest.mock('../../src/database/prisma', () => {
  const mockPrisma: any = {
    gameplayFeedDelivery: {
      updateMany: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    gameplayFeedConfig: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    nitradoConnection: {
      findFirst: jest.fn(),
    },
    admEvent: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
  mockPrisma.$transaction = jest.fn(async (arg: Promise<unknown>[] | ((tx: typeof mockPrisma) => Promise<unknown>)) => {
    if (typeof arg === 'function') return arg(mockPrisma);
    return Promise.all(arg);
  });
  return { __esModule: true, default: mockPrisma };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitServerGameplayEvent: jest.fn(),
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(() => null),
}));

import prisma from '../../src/database/prisma';
import { runGameplayFeedsOnce } from '../../src/modules/gameplayFeeds/runtime';

const GUILD_ID = '111111111111111111';
const CONN_ID = 'conn-production-1';
const CHANNEL_ID = '1542986161947942993';

const deliveryUpdate = prisma.gameplayFeedDelivery.updateMany as jest.Mock;
const deliveryCreate = prisma.gameplayFeedDelivery.create as jest.Mock;
const deliveryFind = prisma.gameplayFeedDelivery.findMany as jest.Mock;
const configFind = prisma.gameplayFeedConfig.findMany as jest.Mock;
const configUpdate = prisma.gameplayFeedConfig.updateMany as jest.Mock;
const connectionFind = prisma.nitradoConnection.findFirst as jest.Mock;
const eventFindMany = prisma.admEvent.findMany as jest.Mock;

function config() {
  return {
    id: 'cmtddpxix0w2p07mxjsztkajy',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    kind: 'DEATH',
    channelId: CHANNEL_ID,
    isActive: true,
    categories: ['SUICIDE', 'NPC', 'VEHICLE', 'PVP'],
    showActorCoords: true,
    showTargetCoords: true,
    showTool: true,
    showDistance: true,
    embedColor: '#dc2626',
    legacyKillfeedConfigId: null,
    cursorCreatedAt: new Date('2026-09-04T21:20:00.000Z'),
    cursorEventId: '',
    nextDeliveryAt: new Date('2026-09-04T21:20:00.000Z'),
    lastMessageId: null,
    lastStateHash: null,
    lastPlayerCount: null,
    lastPlayerListAt: null,
    playerListIntervalMinutes: null,
    nextPlayerListPostAt: null,
    lastEventAt: null,
    lastPolledAt: null,
    lastErrorMsg: null,
    createdAt: new Date('2026-08-28T20:03:23.001Z'),
    updatedAt: new Date('2026-09-04T21:20:00.000Z'),
  };
}

function event(id: string, eventType: string, createdAt: string, actorName: string, targetName: string | null) {
  return {
    id,
    eventType,
    occurredAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    actorGameId: `${id}-actor`,
    actorName,
    targetGameId: targetName ? `${id}-target` : null,
    targetName,
    objectType: null,
    toolOrWeapon: eventType === 'PLAYER_KILLED' ? 'DMR' : null,
    distanceMeters: eventType === 'PLAYER_KILLED' ? 150 : null,
    actorPosition: '5000, 6000, 250',
    targetPosition: targetName ? '5100, 6100, 260' : null,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  deliveryUpdate.mockResolvedValue({ count: 0 });
  deliveryCreate.mockResolvedValue({ id: 'delivery' });
  deliveryFind.mockResolvedValue([]);
  configFind.mockResolvedValue([config()]);
  configUpdate.mockResolvedValue({ count: 1 });
  connectionFind.mockResolvedValue({ alias: 'Chernarus #1' });
});

describe('PvP-Killfeed Mixed-Batch Regression', () => {
  it('verliert PLAYER_KILLED nicht zwischen Suizid- und NPC-Ereignissen desselben Scans', async () => {
    const events = [
      event('kill-1', 'PLAYER_KILLED', '2026-09-04T21:25:53.375Z', 'Balu_cleo', 'DeathshotNo-'),
      event('kill-2', 'PLAYER_KILLED', '2026-09-04T21:25:53.488Z', 'DeathshotNo-', 'Oo_KirscHi_oO'),
      event('suicide-1', 'PLAYER_SUICIDE', '2026-09-04T21:25:53.598Z', 'arm982super', null),
      event('npc-1', 'NPC_KILL', '2026-09-04T21:27:00.000Z', 'Legion_XCIV', 'LandMineTrap'),
      event('kill-3', 'PLAYER_KILLED', '2026-09-04T21:36:53.501Z', 'DeathshotNo-', 'Oo_KirscHi_oO'),
    ];
    eventFindMany.mockResolvedValue(events);

    await runGameplayFeedsOnce();

    expect(deliveryCreate).toHaveBeenCalledTimes(events.length);
    const enqueuedIds = deliveryCreate.mock.calls.map(call => call[0]?.data?.admEventId);
    expect(enqueuedIds).toEqual(events.map(entry => entry.id));
    expect(deliveryCreate.mock.calls.filter(call => String(call[0]?.data?.admEventId).startsWith('kill-'))).toHaveLength(3);

    expect(eventFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        eventType: { in: expect.arrayContaining(['PLAYER_KILLED', 'PLAYER_SUICIDE', 'NPC_KILL', 'VEHICLE_DEATH']) },
      }),
    }));

    expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cursorCreatedAt: events[events.length - 1].createdAt,
        cursorEventId: events[events.length - 1].id,
      }),
    }));
  });
});
