var mockTx: any;
var mockScope: any;
var mockTargets: any[];
var mockOrder: string[];

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
  NitradoClient: jest.fn().mockImplementation(() => ({ getBanlist: async () => [] })),
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '0'.repeat(64) } },
}));

jest.mock('../../src/utils/security', () => ({ decrypt: () => 'valid-test-token' }));
jest.mock('../../src/utils/logger', () => ({ logAudit: jest.fn() }));

import { serverBanCommand, serverUnbanCommand } from '../../src/commands/dashboard/serverBan';

function interactionFor(command: 'ban' | 'unban') {
  const values: Record<string, unknown> = command === 'ban'
    ? { identifier: 'Player-123', grund: 'Testgrund', dauer: null, slot: null }
    : { identifier: 'Player-123', slot: null };
  return {
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
        deleteMany: jest.fn(async () => {
          mockOrder.push('local-whitelist-delete');
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
    };
  });

  it('entfernt zuerst den lokalen Whitelist-Desired-State und queued danach den serialisierten Ban-Worker', async () => {
    const interaction = interactionFor('ban');

    await serverBanCommand.execute(interaction);

    expect(mockOrder).toEqual([
      'local-whitelist-delete',
      'local-request-cancel',
      'add-ban',
      'lookup-ban',
      'enqueue-ban',
    ]);
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Whitelist-Entfernung + Bann'),
    }));
  });

  it('kann einen Remote-Unban nur aus dem Identifier ableiten und braucht keinen VERIFIED Link', async () => {
    const interaction = interactionFor('unban');

    await serverUnbanCommand.execute(interaction);

    expect(mockOrder).toEqual(['upsert-unban-anchor', 'enqueue-unban']);
    expect(mockTx.serverBanEntry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        guildId_nitradoConnId_identityHash: {
          guildId: 'guild-1',
          nitradoConnId: 'conn-a',
          identityHash: 'a'.repeat(64),
        },
      },
    }));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Remote-Unban'),
    }));
  });
});
