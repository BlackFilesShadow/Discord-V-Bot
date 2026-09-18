jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    gameplayFeedConfig: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    admEvent: {
      findFirst: jest.fn(),
    },
    flagActivityEvent: {
      findFirst: jest.fn(),
    },
  },
}));

import prisma from '../../src/database/prisma';
import {
  NITRADO_AUTO_PAUSE_REASON,
  resumeAutoPausedGameplayFeeds,
} from '../../src/modules/gameplayFeeds/autoPauseRecovery';

const configFind = prisma.gameplayFeedConfig.findMany as jest.Mock;
const configUpdate = prisma.gameplayFeedConfig.updateMany as jest.Mock;
const eventFind = prisma.admEvent.findFirst as jest.Mock;
const flagFind = prisma.flagActivityEvent.findFirst as jest.Mock;

const GUILD_ID = '111111111111111111';
const CONN_ID = 'conn-1';

describe('Gameplay-Feed Auto-Pause Recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configUpdate.mockResolvedValue({ count: 1 });
  });

  it('fasst manuell deaktivierte Feeds nicht an', async () => {
    configFind.mockResolvedValue([]);

    await expect(resumeAutoPausedGameplayFeeds({ guildId: GUILD_ID, nitradoConnId: CONN_ID }))
      .resolves.toBe(0);

    expect(configFind).toHaveBeenCalledWith({
      where: {
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        isActive: false,
        autoPausedReason: NITRADO_AUTO_PAUSE_REASON,
      },
      select: {
        id: true,
        kind: true,
        playerListIntervalMinutes: true,
      },
    });
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('setzt einen auto-pausierten Killfeed auf den aktuellen Event-High-Watermark und reaktiviert ihn', async () => {
    const watermark = {
      createdAt: new Date('2026-09-18T22:48:14.633Z'),
      id: 'event-latest',
    };
    configFind.mockResolvedValue([
      { id: 'feed-kill', kind: 'KILL', playerListIntervalMinutes: null },
    ]);
    eventFind.mockResolvedValue(watermark);

    await expect(resumeAutoPausedGameplayFeeds({ guildId: GUILD_ID, nitradoConnId: CONN_ID }))
      .resolves.toBe(1);

    expect(eventFind).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        eventType: { in: ['PLAYER_KILLED'] },
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    }));
    expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'feed-kill',
        guildId: GUILD_ID,
        nitradoConnId: CONN_ID,
        isActive: false,
        autoPausedReason: NITRADO_AUTO_PAUSE_REASON,
      },
      data: expect.objectContaining({
        isActive: true,
        autoPausedReason: null,
        autoPausedAt: null,
        lastErrorMsg: null,
        cursorCreatedAt: watermark.createdAt,
        cursorEventId: watermark.id,
      }),
    }));
  });

  it('reaktiviert die Online-Liste ohne ADM-Backlog und erzwingt einen frischen Zustand', async () => {
    configFind.mockResolvedValue([
      { id: 'feed-online', kind: 'PLAYER_LIST', playerListIntervalMinutes: 5 },
    ]);

    await expect(resumeAutoPausedGameplayFeeds({ guildId: GUILD_ID, nitradoConnId: CONN_ID }))
      .resolves.toBe(1);

    expect(eventFind).not.toHaveBeenCalled();
    expect(flagFind).not.toHaveBeenCalled();
    expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'feed-online' }),
      data: expect.objectContaining({
        isActive: true,
        autoPausedReason: null,
        autoPausedAt: null,
        lastErrorMsg: null,
        lastStateHash: null,
        nextPlayerListPostAt: expect.any(Date),
      }),
    }));
  });

  it('verwendet fuer Flaggen den kanonischen FlagActivity-High-Watermark', async () => {
    const watermark = {
      createdAt: new Date('2026-09-18T22:40:00.000Z'),
      id: 'flag-latest',
    };
    configFind.mockResolvedValue([
      { id: 'feed-flag', kind: 'FLAG', playerListIntervalMinutes: null },
    ]);
    flagFind.mockResolvedValue(watermark);

    await expect(resumeAutoPausedGameplayFeeds({ guildId: GUILD_ID, nitradoConnId: CONN_ID }))
      .resolves.toBe(1);

    expect(flagFind).toHaveBeenCalledWith({
      where: { guildId: GUILD_ID, nitradoConnId: CONN_ID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, id: true },
    });
    expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        cursorCreatedAt: watermark.createdAt,
        cursorEventId: watermark.id,
      }),
    }));
  });
});
