jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiConversationTurn: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

import prisma from '../../src/database/prisma';
import {
  clearConversation,
  getRecentTurns,
  recordTurn,
} from '../../src/modules/ai/conversationMemory';

const turns = prisma.aiConversationTurn as unknown as {
  create: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
  deleteMany: jest.Mock;
};

describe('AI conversation memory scope firewall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    turns.create.mockResolvedValue({});
    turns.findMany.mockResolvedValue([]);
    turns.deleteMany.mockResolvedValue({ count: 0 });
  });

  it('liest mit expliziter Guild-ID nur exakt diesen Scope', async () => {
    turns.findMany.mockResolvedValue([
      { role: 'assistant', content: 'Antwort' },
      { role: 'user', content: 'Frage' },
    ]);

    const result = await getRecentTurns('user-1', 'channel-1', 'guild-A', 8);

    expect(turns.findFirst).not.toHaveBeenCalled();
    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        channelId: 'channel-1',
        guildId: 'guild-A',
      }),
      take: 8,
    }));
    expect(result).toEqual([
      { role: 'user', content: 'Frage' },
      { role: 'assistant', content: 'Antwort' },
    ]);
  });

  it('behandelt DMs als expliziten NULL-Guild-Scope', async () => {
    await getRecentTurns('user-1', 'dm-channel', null, 5);

    expect(turns.findFirst).not.toHaveBeenCalled();
    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        channelId: 'dm-channel',
        guildId: null,
      }),
      take: 5,
    }));
  });

  it('loest Legacy-Callsites vor dem Inhalts-Read auf genau einen gespeicherten Scope auf', async () => {
    turns.findFirst.mockResolvedValue({ guildId: 'guild-B' });

    await getRecentTurns('user-2', 'channel-2');

    expect(turns.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-2', channelId: 'channel-2' }),
      select: { guildId: true },
    }));
    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-2',
        channelId: 'channel-2',
        guildId: 'guild-B',
      }),
    }));
  });

  it('erhaelt den historischen dritten numerischen Limit-Parameter ohne ungescoppten Inhalts-Read', async () => {
    turns.findFirst.mockResolvedValue({ guildId: 'guild-C' });

    await getRecentTurns('user-3', 'channel-3', 4);

    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-C' }),
      take: 4,
    }));
  });

  it('faellt bei fehlendem persistierten Scope geschlossen aus statt alle Guilds zu lesen', async () => {
    turns.findFirst.mockResolvedValue(null);

    await expect(getRecentTurns('user-4', 'channel-4')).resolves.toEqual([]);
    expect(turns.findMany).not.toHaveBeenCalled();
  });

  it('loescht bei explizitem Scope niemals Memory einer anderen Guild', async () => {
    turns.deleteMany.mockResolvedValue({ count: 3 });

    await expect(clearConversation('user-5', 'channel-5', 'guild-A')).resolves.toBe(3);
    expect(turns.findFirst).not.toHaveBeenCalled();
    expect(turns.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-5', channelId: 'channel-5', guildId: 'guild-A' },
    });
  });

  it('loest auch einen Legacy-Clear zuerst auf genau einen Scope auf', async () => {
    turns.findFirst.mockResolvedValue({ guildId: null });
    turns.deleteMany.mockResolvedValue({ count: 2 });

    await expect(clearConversation('user-6', 'dm-channel')).resolves.toBe(2);
    expect(turns.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-6', channelId: 'dm-channel', guildId: null },
    });
  });

  it('persistiert explizite Guild- und DM-Scopes auf Writes', async () => {
    await recordTurn('user-7', 'channel-7', 'user', 'Guild-Text', 'guild-Z');
    await recordTurn('user-7', 'dm-channel', 'assistant', 'DM-Text', null);

    expect(turns.create).toHaveBeenNthCalledWith(1, {
      data: {
        userId: 'user-7',
        channelId: 'channel-7',
        guildId: 'guild-Z',
        role: 'user',
        content: 'Guild-Text',
      },
    });
    expect(turns.create).toHaveBeenNthCalledWith(2, {
      data: {
        userId: 'user-7',
        channelId: 'dm-channel',
        guildId: null,
        role: 'assistant',
        content: 'DM-Text',
      },
    });
  });
});
