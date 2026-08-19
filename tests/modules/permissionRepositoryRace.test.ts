const directFindUnique = jest.fn();
const directUpsert = jest.fn();
const directDeleteMany = jest.fn();
const roleFindUnique = jest.fn();
const roleUpsert = jest.fn();
const roleDeleteMany = jest.fn();
const transaction = jest.fn();

const tx = {
  guildPermissionGrant: {
    findUnique: (...args: unknown[]) => directFindUnique(...args),
    upsert: (...args: unknown[]) => directUpsert(...args),
    deleteMany: (...args: unknown[]) => directDeleteMany(...args),
  },
  guildPermissionRoleGrant: {
    findUnique: (...args: unknown[]) => roleFindUnique(...args),
    upsert: (...args: unknown[]) => roleUpsert(...args),
    deleteMany: (...args: unknown[]) => roleDeleteMany(...args),
  },
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: (...args: unknown[]) => transaction(...args),
    guildPermissionGrant: { findUnique: jest.fn(), findMany: jest.fn() },
    guildPermissionRoleGrant: { findMany: jest.fn() },
  },
}));

import { asGuildId, asUserDiscordId } from '../../src/types/scope';
import { setGrantScope, setRoleGrantScope } from '../../src/modules/permissions/repository';

const GUILD_ID = asGuildId('123456789012345678');
const USER_ID = asUserDiscordId('111111111111111111');
const ACTOR_ID = asUserDiscordId('999999999999999999');
const ROLE_ID = '222222222222222222';

beforeEach(() => {
  jest.clearAllMocks();
  directFindUnique.mockResolvedValue(null);
  directDeleteMany.mockResolvedValue({ count: 1 });
  roleFindUnique.mockResolvedValue(null);
  roleDeleteMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
});

describe('permission repository serializable race handling', () => {
  test('retries a serialization conflict and keeps both existing and newly granted scopes', async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' }))
      .mockImplementationOnce(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'] });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: ['economy.view', 'whitelist.view'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: new Date('2026-08-19T20:00:00.000Z'),
    });

    const result = await setGrantScope(GUILD_ID, USER_ID, 'whitelist.view', true, ACTOR_ID);

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(directUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ permissions: ['economy.view', 'whitelist.view'] }),
    }));
    expect(result.permissions).toEqual(['economy.view', 'whitelist.view']);
  });

  test('retries a first-write unique race instead of surfacing P2002', async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error('unique race'), { code: 'P2002' }))
      .mockImplementationOnce(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    directFindUnique.mockResolvedValue(null);
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: ['economy.view'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: new Date('2026-08-19T20:00:00.000Z'),
    });

    await expect(setGrantScope(GUILD_ID, USER_ID, 'economy.view', true, ACTOR_ID)).resolves.toMatchObject({
      permissions: ['economy.view'],
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('revoking the final direct scope deletes the empty grant row instead of persisting []', async () => {
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'] });

    const result = await setGrantScope(GUILD_ID, USER_ID, 'economy.view', false, ACTOR_ID);

    expect(directDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userDiscordId: USER_ID } });
    expect(directUpsert).not.toHaveBeenCalled();
    expect(result.permissions).toEqual([]);
  });

  test('role grants use the same serialized merge/delete contract', async () => {
    roleFindUnique.mockResolvedValue({ permissions: ['factions.view'] });
    roleUpsert.mockResolvedValue({
      roleDiscordId: ROLE_ID,
      permissions: ['factions.view', 'tickets.manage'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: new Date('2026-08-19T20:00:00.000Z'),
    });

    const granted = await setRoleGrantScope(GUILD_ID, ROLE_ID, 'tickets.manage', true, ACTOR_ID);
    expect(granted.permissions).toEqual(['factions.view', 'tickets.manage']);

    roleFindUnique.mockResolvedValue({ permissions: ['tickets.manage'] });
    const revoked = await setRoleGrantScope(GUILD_ID, ROLE_ID, 'tickets.manage', false, ACTOR_ID);
    expect(roleDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, roleDiscordId: ROLE_ID } });
    expect(revoked.permissions).toEqual([]);
  });
});
