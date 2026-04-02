import leaderboardCommand from '../leaderboard';

describe('Leaderboard Command', () => {
  it('sollte ohne Fehler ausgeführt werden (einmalig)', async () => {
    const interaction: any = {
      deferReply: jest.fn().mockResolvedValue(undefined),
      options: {
        getString: jest.fn().mockReturnValue('once'),
        getInteger: jest.fn().mockReturnValue(undefined),
      },
      editReply: jest.fn().mockResolvedValue(undefined),
      user: { id: '123' },
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
      channelId: 'feedtest',
      channel: { send: jest.fn() },
      user: { id: '123' },
    };
    await leaderboardCommand.execute(interaction);
    expect(interaction.editReply).toBeCalledWith({ content: expect.stringContaining('Feed'), embeds: [] });
    expect(interaction.channel.send).toBeCalled();
  });
});
