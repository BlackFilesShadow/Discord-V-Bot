var mockTx: any;
var mockScope: any;
var mockTargets: any[];
var mockOrder: string[];
var mockRemoteBanRows: Array<{ identifier: string }>;

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(mockTx),
  },
}));

jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  withGuildScope: (_opts: unknown, handler: (interaction: any, scope: any) => Promise<void>) =>
    (interaction: any) => handler(interaction, mockScope),
}));

jest.mock('../../src/commands/dashboard/serverTargetSelection', () => ({
  autocompleteServerAlias: jest.fn(),
  resolveSelectedOrAllServers: async () => mockTargets,
  targetLabel: (target: any) => `${target.alias} (Slot ${target.slot})`,
}));

jest.mock('../../src/modules/bans/banTarget', () => ({
  hashBanIdentifier: () => 'a'.repeat(64),
  matchesBanIdentifier: (identifier: string) => identifier === 'Player-123',
}));

jest.mock('../../src/modules/bans/banRegistry', () => ({
  addBan: async () => { mockOrder.push('add-ban'); },
}));

jest.mock('../../src/modules/bans/banOutbox', () => ({
  enqueueServerBanAdd: async () => {
    mockOrder.push('enqueue-ban');
    return true;
  },
  enqueueServerBanRemove: async () => {
    mockOrder.push('enqueue-unban');
    return true;
  },
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    getBanlist: async () => mockRemoteBanRows,
  })),
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: () => 'valid-test-token',
  encrypt: () => 'encrypted-player',
}));
jest.mock('../../src/utils/logger', () => ({ logAudit: jest.fn() }));

import { serverBanCommand, serverUnbanCommand } from '../../src/commands/dashboard/serverBan';

function interactionFor(command: 'ban' | 'unban', duration: number | null = null) {
  const values: Record<string, unknown> = command === 'ban'
    ? { identifier: 'Player-123', grund: 'Testgrund', dauer: duration, slot: null }
    : { identifier: 'Player-123', slot: null };
  return {
    channelId: 'command-channel-1',
    options: {
      getString: jest.fn((name: string) => values[name] ?? null),
      getInteger: jest.fn((name: string) => values[name] ?? null),
    },
    reply: jest.fn().mockResolvedValue(undefined),
    followUp: jest.fn().mockResolvedValue(undefined),
  } as any;
}

describe('server-ban/server-unban execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrder = [];
    mockRemoteBanRows = [];
    mockScope = {
      guildId: 'guild-1',
      nitradoConnId: null,
      actorDiscordId: 'actor-1',
      isOwner: true,
      permissions: new Set(),
    };
    mockTargets = [{
      id: 'conn-a',
      guildId: 'guild-1',
      slot: 1,
      alias: 'Chernarus Main',
      nitradoServerId: 'srv-a',
      encryptedToken: 'enc-token',
    }];
    mockTx = {
      whitelistEntry: {
        updateMany: jest.fn(async () => {
          mockOrder.push('local-whitelist-pending');
          return { count: 1 };
        }),
      },
      whitelistRequest: {
        updateMany: jest.fn(async () => {
          mockOrder.push('local-request-cancel');
          return { count: 1 };
        }),
      },
      serverBanEntry: {
        findUnique: jest.fn(async () => {
          mockOrder.push('lookup-ban');
          return { id: 'ban-1' };
        }),
        upsert: jest.fn(async () => {
          mockOrder.push('upsert-unban-anchor');
          return { id: 'ban-1' };
        }),
      },
      serverBanExpiryNotice: {
        upsert: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({ count: 0 })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    };
  });

  it('markiert Whitelist PENDING_REMOVE und queued danach den serialisierten Ban-Worker', async () => {
    const interaction = interactionFor('ban');

    await serverBanCommand.execute(interaction);

    expect(mockOrder).toEqual([
      'local-whitelist-pending',
      'local-request-cancel',
      'add-ban',
      'lookup-ban',
      'enqueue-ban',
    ]);
    expect(mockTx.whitelistEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { syncState: 'PENDING_REMOVE', lastSyncedAt: null },
    }));
    expect(mockTx.serverBanExpiryNotice.deleteMany).toHaveBeenCalledWith({ where: { banId: 'ban-1' } });
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      embeds: expect.any(Array),
    }));
  });

  it('speichert bei einem zeitbegrenzten Bann den urspruenglichen Command-Kanal fuer die Ablaufmeldung', async () => {
    const before = Date.now();
    const interaction = interactionFor('ban', 1);

    await serverBanCommand.execute(interaction);

    expect(mockTx.serverBanExpiryNotice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { banId: 'ban-1' },
      create: expect.objectContaining({
        banId: 'ban-1',
        guildId: 'guild-1',
        nitradoConnId: 'conn-a',
        channelId: 'command-channel-1',
        identifierEnc: 'encrypted-player',
        status: 'PENDING',
      }),
    }));
    const call = mockTx.serverBanExpiryNotice.upsert.mock.calls[0][0];
    expect(call.create.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(mockOrder.at(-1)).toBe('enqueue-ban');
  });

  it('queued Remote-Unban nur nachdem der echte Nitrado-Read den Identifier bestaetigt', async () => {
    mockRemoteBanRows = [{ identifier: 'Player-123' }];
    const interaction = interactionFor('unban');

    await serverUnbanCommand.execute(interaction);

    expect(mockOrder).toEqual(['upsert-unban-anchor', 'enqueue-unban']);
    expect(mockTx.serverBanEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ active: false, appliedRemotely: true }),
    }));
    expect(mockTx.serverBanExpiryNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ banId: 'ban-1' }),
      data: expect.objectContaining({ status: 'CANCELLED', identifierEnc: null }),
    }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ embeds: expect.any(Array) }));
  });

  it('erfindet bei remote bereits entferntem Ban kein appliedRemotely und queued keinen Unban', async () => {
    mockRemoteBanRows = [];
    const interaction = interactionFor('unban');

    await serverUnbanCommand.execute(interaction);

    expect(mockOrder).toEqual(['upsert-unban-anchor']);
    expect(mockTx.serverBanEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ active: false, appliedRemotely: false }),
    }));
  });
});