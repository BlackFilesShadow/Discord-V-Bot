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

  it('wartet beim Read auf einen bereits gestarteten Write desselben Scopes', async () => {
    let release!: () => void;
    const writeGate = new Promise<void>((resolve) => { release = resolve; });
    turns.create.mockImplementationOnce(async () => {
      await writeGate;
      return {};
    });
    turns.findMany.mockResolvedValue([
      { role: 'user', content: 'Direkt davor' },
    ]);

    const pendingWrite = recordTurn('user-race', 'channel-race', 'user', 'Direkt davor', 'guild-race');
    await Promise.resolve();

    const pendingRead = getRecentTurns('user-race', 'channel-race', 'guild-race');
    await Promise.resolve();
    await Promise.resolve();

    expect(turns.findMany).not.toHaveBeenCalled();

    release();
    await pendingWrite;
    await expect(pendingRead).resolves.toEqual([
      { role: 'user', content: 'Direkt davor' },
    ]);
    expect(turns.findMany).toHaveBeenCalledTimes(1);
  });

  it('blockiert einen anderen Guild-Scope nicht durch einen fremden pending Write', async () => {
    let release!: () => void;
    const writeGate = new Promise<void>((resolve) => { release = resolve; });
    turns.create.mockImplementationOnce(async () => {
      await writeGate;
      return {};
    });

    const pendingWrite = recordTurn('same-user', 'same-channel', 'user', 'Guild A', 'guild-A');
    await Promise.resolve();

    await getRecentTurns('same-user', 'same-channel', 'guild-B');
    expect(turns.findMany).toHaveBeenCalledTimes(1);
    expect(turns.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ guildId: 'guild-B' }),
    }));

    release();
    await pendingWrite;
  });

  it('serialisiert parallele Writes innerhalb desselben Dialog-Scopes', async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    turns.create
      .mockImplementationOnce(async () => {
        await firstGate;
        return {};
      })
      .mockResolvedValueOnce({});

    const first = recordTurn('user-order', 'channel-order', 'user', 'Frage', 'guild-order');
    const second = recordTurn('user-order', 'channel-order', 'assistant', 'Antwort', 'guild-order');
    await Promise.resolve();
    await Promise.resolve();

    expect(turns.create).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);

    expect(turns.create).toHaveBeenCalledTimes(2);
    expect(turns.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ role: 'user', content: 'Frage' }),
    }));
    expect(turns.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ role: 'assistant', content: 'Antwort' }),
    }));
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
