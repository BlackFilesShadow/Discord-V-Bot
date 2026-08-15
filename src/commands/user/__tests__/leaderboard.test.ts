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
    botConfig: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));

jest.mock('../../../utils/logger', () => ({
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import leaderboardCommand from '../leaderboard';

describe('Leaderboard Command', () => {
  it('sollte ohne Fehler ausgefuehrt werden (einmalig)', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockImplementation((name: string) => name === 'modus' ? 'once' : null),
        getInteger: jest.fn().mockReturnValue(undefined),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
      user: { id: '123' },
      guildId: 'g1',
      channelId: 'test',
      channel: { send: jest.fn() },
    };
    await leaderboardCommand.execute(interaction);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('startet den persistenten Feed nur mit ManageGuild', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockImplementation((name: string) => name === 'modus' ? 'feed' : null),
        getInteger: jest.fn().mockImplementation((name: string) => name === 'intervall' ? 1 : undefined),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
      guildId: 'g1',
      channelId: 'feedtest',
      channel: { send: jest.fn() },
      client: { channels: { fetch: jest.fn() } },
      user: { id: '123' },
      memberPermissions: { has: jest.fn().mockReturnValue(true) },
    };

    await leaderboardCommand.execute(interaction);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
    const embeds = interaction.editReply.mock.calls[0][0].embeds;
    expect(embeds).toHaveLength(2);
    expect(embeds[0].toJSON().title).toContain('Leaderboard-Feed aktiviert');
  });

  it('weist Feed-Verwaltung ohne ManageGuild als Embed ab und startet keinen Feed', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockImplementation((name: string) => name === 'modus' ? 'feed' : null),
        getInteger: jest.fn().mockImplementation((name: string) => name === 'intervall' ? 1 : undefined),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
      guildId: 'g1',
      channelId: 'feedtest',
      user: { id: '123' },
      memberPermissions: { has: jest.fn().mockReturnValue(false) },
    };

    await leaderboardCommand.execute(interaction);

    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });
});