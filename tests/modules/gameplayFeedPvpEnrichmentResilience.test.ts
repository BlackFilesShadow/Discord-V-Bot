import type { Client } from 'discord.js';

jest.mock('../../src/database/prisma', () => {
  const mockPrisma: any = {
    gameplayFeedDelivery: {
      updateMany: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
    },
    gameplayFeedConfig: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    nitradoConnection: {
      findFirst: jest.fn(),
    },
    admEvent: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
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
  __esModule: true,
  emitServerGameplayEvent: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { logger } from '../../src/utils/logger';
import { setDashboardClient } from '../../src/dashboard/clientRegistry';
import { runGameplayFeedsOnce } from '../../src/modules/gameplayFeeds/runtime';

const deliveryUpdate = prisma.gameplayFeedDelivery.updateMany as jest.Mock;
const deliveryCreate = prisma.gameplayFeedDelivery.create as jest.Mock;
const deliveryFind = prisma.gameplayFeedDelivery.findMany as jest.Mock;
const configFind = prisma.gameplayFeedConfig.findMany as jest.Mock;
const configFindFirst = prisma.gameplayFeedConfig.findFirst as jest.Mock;
const configUpdate = prisma.gameplayFeedConfig.updateMany as jest.Mock;
const connectionFind = prisma.nitradoConnection.findFirst as jest.Mock;
const eventFindMany = prisma.admEvent.findMany as jest.Mock;
const eventFindFirst = prisma.admEvent.findFirst as jest.Mock;
const queryRaw = prisma.$queryRaw as jest.Mock;
const loggerWarn = logger.warn as jest.Mock;

const GUILD_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';
const CONN_ID = 'conn-live-1';

function feedConfig() {
  return {
    id: 'feed-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    kind: 'DEATH',
    channelId: CHANNEL_ID,
    isActive: true,
    categories: ['PVP', 'SUICIDE', 'NPC', 'VEHICLE'],
    showActorCoords: true,
    showTargetCoords: true,
    showTool: true,
    showDistance: true,
    embedColor: '#dc2626',
    legacyKillfeedConfigId: null,
    cursorCreatedAt: new Date('2026-09-05T05:59:00.000Z'),
    cursorEventId: '',
    nextDeliveryAt: new Date('2026-09-05T05:59:00.000Z'),
    lastMessageId: null,
    lastStateHash: null,
    lastPlayerCount: null,
    lastPlayerListAt: null,
    playerListIntervalMinutes: null,
    nextPlayerListPostAt: null,
    lastEventAt: null,
    lastPolledAt: null,
    lastErrorMsg: null,
    createdAt: new Date('2026-09-05T05:59:00.000Z'),
    updatedAt: new Date('2026-09-05T05:59:00.000Z'),
  };
}

function killEvent() {
  return {
    id: 'adm-kill-1',
    eventType: 'PLAYER_KILLED',
    occurredAt: new Date('2026-09-05T06:00:10.000Z'),
    createdAt: new Date('2026-09-05T06:00:11.000Z'),
    actorGameId: 'victim-id',
    actorName: 'Victim',
    targetGameId: 'killer-id',
    targetName: 'Killer',
    objectType: null,
    toolOrWeapon: 'M4-A1',
    distanceMeters: 42.5,
    actorPosition: '100,200,10',
    targetPosition: '110,210,10',
  };
}

function pendingDelivery() {
  return {
    id: 'delivery-1',
    configId: 'feed-1',
    admEventId: 'adm-kill-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    channelId: CHANNEL_ID,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date('2026-09-05T06:00:11.000Z'),
    leaseUntil: null,
    messageId: null,
    lastError: null,
    sentAt: null,
    createdAt: new Date('2026-09-05T06:00:11.000Z'),
    updatedAt: new Date('2026-09-05T06:00:11.000Z'),
  };
}

function bindDiscord(send: jest.Mock) {
  setDashboardClient({
    channels: {
      fetch: jest.fn().mockResolvedValue({
        guildId: GUILD_ID,
        isTextBased: () => true,
        isDMBased: () => false,
        send,
      }),
    },
  } as unknown as Client);
}

function wireCommonRuntime(event: ReturnType<typeof killEvent>, send: jest.Mock) {
  const config = feedConfig();
  const delivery = pendingDelivery();

  deliveryUpdate.mockResolvedValue({ count: 1 });
  deliveryCreate.mockResolvedValue({ id: delivery.id });
  deliveryFind.mockResolvedValue([delivery]);
  configUpdate.mockResolvedValue({ count: 1 });
  configFind.mockResolvedValue([config]);
  configFindFirst.mockImplementation((args: { where?: { id?: string; isActive?: boolean } }) => (
    args?.where?.id === config.id && args.where.isActive === true ? { id: config.id } : null
  ));
  connectionFind.mockResolvedValue({ id: CONN_ID, alias: 'Chernarus #1' });
  eventFindMany.mockResolvedValue([event]);
  queryRaw.mockResolvedValue([{ id: config.id }]);
  bindDiscord(send);

  return { config, delivery };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PvP-Killfeed Zusatzinformationen', () => {
  it('liefert den Basis-Kill weiter aus, wenn die optionale Trefferabfrage fehlschlaegt', async () => {
    const event = killEvent();
    const send = jest.fn().mockResolvedValue({ id: 'discord-message-1' });
    const { delivery } = wireCommonRuntime(event, send);

    eventFindFirst
      .mockResolvedValueOnce(event)
      .mockRejectedValueOnce(new Error('temporary PvP enrichment lookup failure'));

    await runGameplayFeedsOnce();

    expect(send).toHaveBeenCalledTimes(1);
    const embed = send.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Killer' }),
      expect.objectContaining({ name: 'Opfer' }),
      expect.objectContaining({ name: 'Waffe', value: 'M4-A1' }),
      expect.objectContaining({ name: 'Distanz', value: '42.5 m' }),
      expect.objectContaining({ name: 'Server', value: 'Chernarus #1' }),
    ]));
    expect((embed.fields ?? []).map((field: { name: string }) => field.name)).not.toContain('Schaden');

    const deliveryCalls = deliveryUpdate.mock.calls
      .map(call => call[0])
      .filter(call => call?.where?.id === delivery.id);
    expect(deliveryCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', messageId: 'discord-message-1' }) }),
    ]));
    expect(deliveryCalls).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ status: 'RETRY' }) }),
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    ]));
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('optionale PvP-Trefferdetails uebersprungen'));
  });

  it('zeigt verifizierten Koerperteil und Schaden auch dann, wenn nur die Kill-Zeile die Waffe nennt', async () => {
    const event = killEvent();
    const send = jest.fn().mockResolvedValue({ id: 'discord-message-2' });
    const { delivery } = wireCommonRuntime(event, send);
    const hitLine = '06:00:09 | Player "Victim" (id=victim-id pos=<100,200,10>)[HP: 12] hit by Player "Killer" (id=killer-id pos=<110,210,10>) into Head(0) for 12.5 damage (FirearmHit_Rifle)';

    eventFindFirst
      .mockResolvedValueOnce(event)
      .mockResolvedValueOnce({ rawLine: hitLine });

    await runGameplayFeedsOnce();

    expect(send).toHaveBeenCalledTimes(1);
    const embed = send.mock.calls[0][0].embeds[0].toJSON();
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Waffe', value: 'M4-A1' }),
      expect.objectContaining({ name: 'Getroffener Körperteil', value: 'Head' }),
      expect.objectContaining({ name: 'Schaden', value: expect.stringContaining('12,5') }),
      expect.objectContaining({ name: 'Server', value: 'Chernarus #1' }),
    ]));

    const deliveryCalls = deliveryUpdate.mock.calls
      .map(call => call[0])
      .filter(call => call?.where?.id === delivery.id);
    expect(deliveryCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({ status: 'SENT', messageId: 'discord-message-2' }) }),
    ]));
    expect(loggerWarn).not.toHaveBeenCalledWith(expect.stringContaining('optionale PvP-Trefferdetails uebersprungen'));
  });
});
