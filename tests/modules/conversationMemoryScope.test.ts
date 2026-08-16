import fs from 'node:fs';
import path from 'node:path';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    aiConversationTurn: {
      create: jest.fn(),
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

    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        channelId: 'dm-channel',
        guildId: null,
      }),
      take: 5,
    }));
  });

  it('kann identische User/Channel-Werte zwischen Guild und DM niemals vermischen', async () => {
    await getRecentTurns('user-shared', 'channel-shared', 'guild-A', 4);
    await getRecentTurns('user-shared', 'channel-shared', 'guild-B', 4);
    await getRecentTurns('user-shared', 'channel-shared', null, 4);

    expect(turns.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-A' }),
    }));
    expect(turns.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-B' }),
    }));
    expect(turns.findMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
      where: expect.objectContaining({ guildId: null }),
    }));
  });

  it('begrenzt Reads defensiv auf maximal 10 Turns', async () => {
    await getRecentTurns('user-3', 'channel-3', 'guild-C', 999);
    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });

  it('loescht bei explizitem Scope niemals Memory einer anderen Guild', async () => {
    turns.deleteMany.mockResolvedValue({ count: 3 });

    await expect(clearConversation('user-5', 'channel-5', 'guild-A')).resolves.toBe(3);
    expect(turns.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-5', channelId: 'channel-5', guildId: 'guild-A' },
    });
  });

  it('loescht DMs nur im expliziten NULL-Scope', async () => {
    turns.deleteMany.mockResolvedValue({ count: 2 });

    await expect(clearConversation('user-6', 'dm-channel', null)).resolves.toBe(2);
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

  it('enthaelt keinerlei Legacy-Scope-Inferenz mehr', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/ai/conversationMemory.ts'),
      'utf8',
    );
    expect(source).not.toContain('resolveStoredScope');
    expect(source).not.toContain('findFirst(');
    expect(source).not.toContain('guildScopeOrLimit');
  });

  it('uebergibt der produktive aiHandler beim Memory-Read immer den Guild-/DM-Scope', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/ai/aiHandler.ts'),
      'utf8',
    );
    expect(source).toContain(
      'getRecentTurns(opts.userId!, opts.channelId!, opts.guildId ?? null)',
    );
    expect(source).not.toContain(
      'getRecentTurns(opts.userId!, opts.channelId!)',
    );
  });
});
