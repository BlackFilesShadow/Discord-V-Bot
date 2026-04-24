// Prisma muss VOR dem Import des Commands gemockt werden,
// damit der Command die Mock-Instanz erhaelt (kein echter DB-Call).
jest.mock('../../../database/prisma', () => ({
  __esModule: true,
  default: {
    levelData: {
      findMany: jest.fn().mockResolvedValue([
        {
          xp: 1500,
          level: 5,
          totalMessages: 120,
          voiceMinutes: 45,
          guildId: 'g1',
          user: { discordId: '123' },
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
      findUnique: jest.fn().mockResolvedValue({
        xp: 1500n,
        level: 5,
        guildId: 'g1',
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'u1',
        discordId: '123',
      }),
    },
  },
}));

import leaderboardCommand from '../leaderboard';

describe('Leaderboard Command', () => {
  afterEach(() => {
    // Feed-Intervalle aufraeumen, damit Jest sauber beendet
    const gAny = globalThis as any;
    if (gAny.leaderboardFeeds) {
      for (const key of Object.keys(gAny.leaderboardFeeds)) {
        clearInterval(gAny.leaderboardFeeds[key]);
        delete gAny.leaderboardFeeds[key];
      }
    }
  });

  it('sollte ohne Fehler ausgeführt werden (einmalig)', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockReturnValue('once'),
        getInteger: jest.fn().mockReturnValue(undefined),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      user: { id: '123' },
      guildId: 'g1',
      channelId: 'test',
      channel: { send: jest.fn() },
    };
    await leaderboardCommand.execute(interaction);
    expect(interaction.deferReply).toBeCalled();
    expect(interaction.editReply).toBeCalled();
  });

  it('sollte den Feed-Modus starten', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockReturnValue('feed'),
        getInteger: jest.fn().mockReturnValue(1),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      guildId: 'g1',
      channelId: 'feedtest',
      channel: { send: jest.fn() },
      user: { id: '123' },
    };
    await leaderboardCommand.execute(interaction);
    expect(interaction.editReply).toBeCalledWith({ content: expect.stringContaining('Feed'), embeds: [] });
    expect(interaction.channel.send).toBeCalled();
  });
});
