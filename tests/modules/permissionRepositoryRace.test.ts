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
import {
  PermissionMembershipEpochConflictError,
  setGrantScope,
  setRoleGrantScope,
} from '../../src/modules/permissions/repository';
import { membershipEpochMarker, storedDirectPermissions } from '../../src/modules/permissions/access';

const GUILD_ID = asGuildId('123456789012345678');
const USER_ID = asUserDiscordId('111111111111111111');
const ACTOR_ID = asUserDiscordId('999999999999999999');
const ROLE_ID = '222222222222222222';
const JOINED_AT = new Date('2026-08-19T19:00:00.000Z');
const CURRENT_AT = new Date('2026-08-19T20:00:00.000Z');
const STALE_AT = new Date('2026-08-19T18:00:00.000Z');
const NEWER_JOINED_AT = new Date('2026-08-19T21:00:00.000Z');

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
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
      updatedAt: CURRENT_AT,
    });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: storedDirectPermissions(['economy.view', 'whitelist.view'], JOINED_AT),
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
      update: expect.objectContaining({
        permissions: [
          membershipEpochMarker(JOINED_AT),
          'economy.view',
          'whitelist.view',
        ],
      }),
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
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
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
    expect(directUpsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        permissions: [membershipEpochMarker(JOINED_AT), 'economy.view'],
      }),
    }));
  });

  test('grant after rejoin never resurrects scopes from an older explicit membership epoch', async () => {
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], new Date(JOINED_AT.getTime() - 60_000)),
      updatedAt: CURRENT_AT,
    });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: storedDirectPermissions(['whitelist.view'], JOINED_AT),
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
      create: expect.objectContaining({
        permissions: [membershipEpochMarker(JOINED_AT), 'whitelist.view'],
      }),
      update: expect.objectContaining({
        permissions: [membershipEpochMarker(JOINED_AT), 'whitelist.view'],
      }),
    }));
    expect(result.permissions).toEqual(['whitelist.view']);
  });

  test('legacy pre-marker grant after rejoin uses updatedAt fallback and never resurrects old scopes', async () => {
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view'],
      updatedAt: STALE_AT,
    });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: storedDirectPermissions(['whitelist.view'], JOINED_AT),
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
      update: expect.objectContaining({
        permissions: [membershipEpochMarker(JOINED_AT), 'whitelist.view'],
      }),
    }));
    expect(result.permissions).toEqual(['whitelist.view']);
  });

  test('older in-flight request cannot overwrite a newer persisted membership epoch (ABA fence)', async () => {
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], NEWER_JOINED_AT),
      updatedAt: new Date(NEWER_JOINED_AT.getTime() + 1000),
    });

    await expect(setGrantScope(
      GUILD_ID,
      USER_ID,
      'whitelist.view',
      true,
      ACTOR_ID,
      JOINED_AT,
    )).rejects.toBeInstanceOf(PermissionMembershipEpochConflictError);

    expect(directUpsert).not.toHaveBeenCalled();
    expect(directDeleteMany).not.toHaveBeenCalled();
  });

  test('missing member evidence cannot destructively touch an explicitly generation-marked row', async () => {
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
      updatedAt: CURRENT_AT,
    });

    await expect(setGrantScope(GUILD_ID, USER_ID, 'economy.view', false, ACTOR_ID, null))
      .rejects.toBeInstanceOf(PermissionMembershipEpochConflictError);

    expect(directDeleteMany).not.toHaveBeenCalled();
    expect(directUpsert).not.toHaveBeenCalled();
  });

  test('partial revoke of a stale legacy pre-rejoin row deletes the whole stale grant instead of refreshing remaining scopes', async () => {
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

  test('revoke without current membership evidence purges an unmarked legacy row fail-closed', async () => {
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

  test('non-delegable direct scopes stay blocked for grants but can be fail-safe removed from current legacy rows', async () => {
    await expect(setGrantScope(GUILD_ID, USER_ID, 'permissions.manage', true, ACTOR_ID, JOINED_AT))
      .rejects.toThrow('nicht delegierbar');
    expect(transaction).not.toHaveBeenCalled();

    directFindUnique.mockResolvedValue({
      permissions: ['economy.view', 'permissions.manage'],
      updatedAt: CURRENT_AT,
    });
    directUpsert.mockResolvedValue({
      userDiscordId: USER_ID,
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
      grantedByDiscordId: ACTOR_ID,
      updatedAt: CURRENT_AT,
    });

    const cleaned = await setGrantScope(
      GUILD_ID,
      USER_ID,
      'permissions.manage',
      false,
      ACTOR_ID,
      JOINED_AT,
    );

    expect(directUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        permissions: [membershipEpochMarker(JOINED_AT), 'economy.view'],
      }),
    }));
    expect(cleaned.permissions).toEqual(['economy.view']);
  });

  test('revoking the final current direct scope deletes the empty grant row instead of persisting only metadata', async () => {
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
      updatedAt: CURRENT_AT,
    });

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

  test('non-delegable role scopes stay blocked for grants but legacy values are removed on revoke', async () => {
    await expect(setRoleGrantScope(GUILD_ID, ROLE_ID, 'permissions.manage', true, ACTOR_ID))
      .rejects.toThrow('nicht delegierbar');
    expect(transaction).not.toHaveBeenCalled();

    roleFindUnique.mockResolvedValue({ permissions: ['tickets.manage', 'permissions.manage'] });
    roleUpsert.mockResolvedValue({
      roleDiscordId: ROLE_ID,
      permissions: ['tickets.manage'],
      grantedByDiscordId: ACTOR_ID,
      updatedAt: CURRENT_AT,
    });

    const cleaned = await setRoleGrantScope(GUILD_ID, ROLE_ID, 'permissions.manage', false, ACTOR_ID);

    expect(roleUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ permissions: ['tickets.manage'] }),
    }));
    expect(cleaned.permissions).toEqual(['tickets.manage']);
  });
});
