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
const JOINED_AT = new Date('2026-08-19T19:00:00.000Z');
const CURRENT_AT = new Date('2026-08-19T20:00:00.000Z');
const STALE_AT = new Date('2026-08-19T18:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  directFindUnique.mockResolvedValue(null);
  directDeleteMany.mockResolvedValue({ count: 1 });
  roleFindUnique.mockResolvedValue(null);
  roleDeleteMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
});

describe('permission repository serializable race handling', () => {
  test('retries a serialization conflict and keeps scopes from the current membership epoch', async () => {
    transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' }))
      .mockImplementationOnce(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx));
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'], updatedAt: CURRENT_AT });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: ['economy.view', 'whitelist.view'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: CURRENT_AT,
    });

    const result = await setGrantScope(
      GUILD_ID,
      USER_ID,
      'whitelist.view',
      true,
      ACTOR_ID,
      JOINED_AT,
    );

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
      updatedAt: CURRENT_AT,
    });

    await expect(setGrantScope(
      GUILD_ID,
      USER_ID,
      'economy.view',
      true,
      ACTOR_ID,
      JOINED_AT,
    )).resolves.toMatchObject({ permissions: ['economy.view'] });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  test('grant after rejoin never resurrects scopes from an older membership epoch', async () => {
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view'],
      updatedAt: STALE_AT,
    });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: ['whitelist.view'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: CURRENT_AT,
    });

    const result = await setGrantScope(
      GUILD_ID,
      USER_ID,
      'whitelist.view',
      true,
      ACTOR_ID,
      JOINED_AT,
    );

    expect(directUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ permissions: ['whitelist.view'] }),
      update: expect.objectContaining({ permissions: ['whitelist.view'] }),
    }));
    expect(result.permissions).toEqual(['whitelist.view']);
  });

  test('partial revoke of a stale pre-rejoin row deletes the whole stale grant instead of refreshing remaining scopes', async () => {
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view', 'whitelist.view'],
      updatedAt: STALE_AT,
    });

    const result = await setGrantScope(
      GUILD_ID,
      USER_ID,
      'whitelist.view',
      false,
      ACTOR_ID,
      JOINED_AT,
    );

    expect(directDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userDiscordId: USER_ID } });
    expect(directUpsert).not.toHaveBeenCalled();
    expect(result.permissions).toEqual([]);
  });

  test('revoke without current membership evidence purges the direct row fail-closed', async () => {
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view', 'whitelist.view'],
      updatedAt: CURRENT_AT,
    });

    const result = await setGrantScope(GUILD_ID, USER_ID, 'economy.view', false, ACTOR_ID, null);

    expect(directDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, userDiscordId: USER_ID } });
    expect(directUpsert).not.toHaveBeenCalled();
    expect(result.permissions).toEqual([]);
  });

  test('grant without a trusted current membership epoch fails before any transaction', async () => {
    await expect(setGrantScope(GUILD_ID, USER_ID, 'economy.view', true, ACTOR_ID, null))
      .rejects.toThrow('Aktuelle Guild-Mitgliedschaft');
    expect(transaction).not.toHaveBeenCalled();
  });

  test('revoking the final current direct scope deletes the empty grant row instead of persisting []', async () => {
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'], updatedAt: CURRENT_AT });

    const result = await setGrantScope(
      GUILD_ID,
      USER_ID,
      'economy.view',
      false,
      ACTOR_ID,
      JOINED_AT,
    );

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
      updatedAt: CURRENT_AT,
    });

    const granted = await setRoleGrantScope(GUILD_ID, ROLE_ID, 'tickets.manage', true, ACTOR_ID);
    expect(granted.permissions).toEqual(['factions.view', 'tickets.manage']);

    roleFindUnique.mockResolvedValue({ permissions: ['tickets.manage'] });
    const revoked = await setRoleGrantScope(GUILD_ID, ROLE_ID, 'tickets.manage', false, ACTOR_ID);
    expect(roleDeleteMany).toHaveBeenCalledWith({ where: { guildId: GUILD_ID, roleDiscordId: ROLE_ID } });
    expect(revoked.permissions).toEqual([]);
  });
});
