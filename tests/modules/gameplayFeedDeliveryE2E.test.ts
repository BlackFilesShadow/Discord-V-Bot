/**
 * End-to-End-Regression fuer die produktive Gameplay-Feed-Kette:
 * rohe DayZ-ADM-Zeile -> Parser/Ingest -> persistiertes AdmEvent -> Feed-Scan
 * -> Discord-Embed -> persistenter SENT/RETRY-Status.
 */
import fs from 'node:fs';
import path from 'node:path';

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

import type { Client } from 'discord.js';
import prisma from '../../src/database/prisma';
import { setDashboardClient } from '../../src/dashboard/clientRegistry';
import { emitServerGameplayEvent } from '../../src/dashboard/socket/emitter';
import { ingestChunk, persistAdmEvents, type AdmPersistClient } from '../../src/modules/nitrado/adm/serverLogIngestor';
import { newDateContext } from '../../src/modules/nitrado/adm/admLineParser';
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
const realtimeEmit = emitServerGameplayEvent as jest.Mock;

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
    categories: ['PVP', 'DEATH', 'SUICIDE', 'NPC', 'VEHICLE'],
    showActorCoords: true,
    showTargetCoords: true,
    showTool: true,
    showDistance: true,
    embedColor: '#dc2626',
    legacyKillfeedConfigId: null,
    cursorCreatedAt: new Date('2026-08-15T11:59:00.000Z'),
    cursorEventId: '',
    nextDeliveryAt: new Date('2026-08-15T11:59:00.000Z'),
    lastMessageId: null,
    lastStateHash: null,
    lastPlayerCount: null,
    lastPlayerListAt: null,
    lastEventAt: null,
    lastPolledAt: null,
    lastErrorMsg: null,
    createdAt: new Date('2026-08-15T11:59:00.000Z'),
    updatedAt: new Date('2026-08-15T11:59:00.000Z'),
  };
}

async function persistedPvpEvent() {
  const stored: Array<Record<string, unknown>> = [];
  const persistClient: AdmPersistClient = {
    admEvent: {
      createMany: async ({ data }) => {
        const rows = data as Array<Record<string, unknown>>;
        stored.push(...rows);
        return { count: rows.length };
      },
    },
    admSourceCursor: { upsert: async () => ({}) },
    $transaction: async <T>(fn: (tx: AdmPersistClient) => Promise<T>) => fn(persistClient),
  };

  const line = '12:00:10 | Player "Victim"(DEAD) (id=victim-id pos=<100,200,10>) killed by Player "Killer" (id=killer-id pos=<110,210,10>) with M4-A1 from 42.5 meters\n';
  const parsed = ingestChunk(line, 0, {
    fileName: 'DayZServer_2026-08-15_12-00-00.ADM',
    dateCtx: newDateContext(new Date(Date.UTC(2026, 7, 15))),
  });

  expect(parsed.events).toHaveLength(1);
  expect(parsed.events[0]).toMatchObject({
    eventType: 'PLAYER_KILLED',
    actorName: 'Victim',
    targetName: 'Killer',
    toolOrWeapon: 'M4-A1',
    distanceMeters: 42.5,
  });

  await persistAdmEvents(
    persistClient,
    { guildId: GUILD_ID, nitradoConnId: CONN_ID },
    { fileIdentity: 'live.ADM', fileName: 'live.ADM', lastModifiedAt: 1, fileSize: Buffer.byteLength(line) },
    parsed,
    null,
  );

  expect(stored).toHaveLength(1);
  return {
    id: 'adm-event-1',
    ...stored[0],
    createdAt: new Date('2026-08-15T12:00:11.000Z'),
  };
}

function pendingDelivery() {
  return {
    id: 'delivery-1',
    configId: 'feed-1',
    admEventId: 'adm-event-1',
    guildId: GUILD_ID,
    nitradoConnId: CONN_ID,
    channelId: CHANNEL_ID,
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: new Date('2026-08-15T12:00:11.000Z'),
    leaseUntil: null,
    messageId: null,
    lastError: null,
    sentAt: null,
    createdAt: new Date('2026-08-15T12:00:11.000Z'),
    updatedAt: new Date('2026-08-15T12:00:11.000Z'),
  };
}

function bindDiscord(channelFetch: jest.Mock) {
  setDashboardClient({
    channels: { fetch: channelFetch },
  } as unknown as Client);
}

beforeEach(() => {
  jest.clearAllMocks();
  deliveryUpdate.mockResolvedValue({ count: 1 });
  deliveryCreate.mockResolvedValue({ id: 'delivery-1' });
  deliveryFind.mockResolvedValue([]);
  configUpdate.mockResolvedValue({ count: 1 });
  configFindFirst.mockImplementation((args: { where?: { id?: string; isActive?: boolean } }) => (
    args?.where?.id === 'feed-1' && args.where.isActive === true ? { id: 'feed-1' } : null
  ));
  connectionFind.mockResolvedValue({ id: CONN_ID });
  queryRaw.mockResolvedValue([{ id: 'feed-1' }]);
});

describe('produktive ADM -> Discord Gameplay-Feed-Kette', () => {
  it('sendet einen neu gelesenen PvP-Kill clean, mit Kartenlinks und stabiler Discord-Nonce', async () => {
    const event = await persistedPvpEvent();
    const config = feedConfig();
    const delivery = pendingDelivery();
    const send = jest.fn().mockResolvedValue({ id: 'discord-message-1' });
    const channelFetch = jest.fn().mockResolvedValue({
      guildId: GUILD_ID,
      isTextBased: () => true,
      isDMBased: () => false,
      send,
    });
    bindDiscord(channelFetch);

    configFind.mockResolvedValue([config]);
    eventFindMany.mockResolvedValue([event]);
    eventFindFirst.mockResolvedValue(event);
    deliveryFind.mockResolvedValue([delivery]);

    await runGameplayFeedsOnce();

    expect(deliveryFind).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }));

    expect(deliveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configId: config.id,
        admEventId: event.id,
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        channelId: CHANNEL_ID,
        status: 'PENDING',
      }),
    });
    expect(channelFetch).toHaveBeenCalledWith(CHANNEL_ID);
    expect(send).toHaveBeenCalledTimes(1);

    const payload = send.mock.calls[0][0];
    const embed = payload.embeds[0].toJSON();
    expect(embed.title).toBe('💀 PvP-Kill');
    expect(embed.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Opfer', value: 'Victim' }),
      expect.objectContaining({ name: 'Killer', value: 'Killer' }),
      expect.objectContaining({ name: 'Waffe', value: 'M4-A1' }),
      expect.objectContaining({ name: 'Distanz', value: '42.5 m' }),
      expect.objectContaining({ name: 'Opfer-Position', value: '[100,200,10](https://www.izurvive.com/#location=100;200;6)' }),
      expect.objectContaining({ name: 'Killer-Position', value: '[110,210,10](https://www.izurvive.com/#location=110;210;6)' }),
    ]));
    expect(embed.footer).toBeUndefined();
    expect(embed.timestamp).toBeUndefined();
    expect(payload.nonce).toBe(event.id.slice(0, 25));
    expect(payload.enforceNonce).toBe(true);

    expect(deliveryUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: delivery.id, status: 'SENDING' }),
      data: expect.objectContaining({ status: 'SENT', messageId: 'discord-message-1' }),
    }));
    expect(realtimeEmit).toHaveBeenCalledWith(expect.objectContaining({
      guildId: GUILD_ID,
      nitradoConnId: CONN_ID,
      eventId: event.id,
      eventType: 'PLAYER_KILLED',
      actorName: 'Victim',
      targetName: 'Killer',
      weapon: 'M4-A1',
      distance: 42.5,
    }));
  });

  it('unterdrueckt den generischen Tod, wenn derselbe Spieler direkt als Suizid erkannt wurde', async () => {
    const config = feedConfig();
    const suicide = {
      id: 'suicide-event-1',
      eventType: 'PLAYER_SUICIDE',
      occurredAt: new Date('2026-08-15T12:00:10.000Z'),
      createdAt: new Date('2026-08-15T12:00:11.000Z'),
      actorGameId: 'player-1',
      actorName: 'Void__Architect',
      targetGameId: null,
      targetName: null,
      objectType: null,
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: '3005, 13205, 211.6',
      targetPosition: null,
    };
    const genericDeath = {
      ...suicide,
      id: 'generic-death-event-1',
      eventType: 'PLAYER_DIED',
      createdAt: new Date('2026-08-15T12:00:12.000Z'),
    };

    configFind.mockResolvedValue([config]);
    eventFindMany.mockResolvedValue([suicide, genericDeath]);
    eventFindFirst.mockImplementation(async (args: { where?: { eventType?: { in?: string[] } } }) => (
      args?.where?.eventType?.in ? { id: suicide.id } : null
    ));

    await runGameplayFeedsOnce();

    expect(deliveryCreate).toHaveBeenCalledTimes(1);
    expect(deliveryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ admEventId: suicide.id, status: 'PENDING' }),
    });
    expect(deliveryCreate).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ admEventId: genericDeath.id }),
    });
  });

  it('macht einen temporaer nicht erreichbaren Discord-Channel retrybar statt den Kill zu verlieren', async () => {
    const event = await persistedPvpEvent();
    const config = feedConfig();
    const delivery = pendingDelivery();
    bindDiscord(jest.fn().mockResolvedValue(null));

    configFind.mockResolvedValue([config]);
    eventFindMany.mockResolvedValue([event]);
    eventFindFirst.mockResolvedValue(event);
    deliveryFind.mockResolvedValue([delivery]);

    await runGameplayFeedsOnce();

    expect(deliveryUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: delivery.id, status: 'SENDING' }),
      data: expect.objectContaining({
        status: 'RETRY',
        attempts: 1,
        leaseUntil: null,
        lastError: 'Feed-Channel nicht verfuegbar/Text-Channel',
      }),
    }));
  });

  it('haelt die Gameplay-Feed-Runtime nicht mehr hinter ADM_EVENT_PIPELINE_V2 verborgen', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../src/modules/nitrado/runtime.ts'),
      'utf8',
    );
    expect(source).toContain('startGameplayFeedRuntime();');
    expect(source).not.toContain('if (config.nitrado.admEventPipelineV2)');
  });
});