jest.mock('../../src/database/prisma', () => {
  const userRows = new Map<string, any>();
  const roleRows = new Map<string, any>();
  let lockTail: Promise<void> = Promise.resolve();

  function key(guildId: string, targetId: string): string {
    return `${guildId}:${targetId}`;
  }

  function userModel() {
    return {
      findUnique: jest.fn(async ({ where }: any) => userRows.get(key(where.guildId_userDiscordId.guildId, where.guildId_userDiscordId.userDiscordId)) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = key(where.guildId_userDiscordId.guildId, where.guildId_userDiscordId.userDiscordId);
        const previous = userRows.get(k);
        const row = { ...(previous ?? create), ...(previous ? update : {}), updatedAt: new Date() };
        userRows.set(k, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const k = key(where.guildId_userDiscordId.guildId, where.guildId_userDiscordId.userDiscordId);
        const previous = userRows.get(k);
        userRows.delete(k);
        return previous;
      }),
    };
  }

  function roleModel() {
    return {
      findUnique: jest.fn(async ({ where }: any) => roleRows.get(key(where.guildId_roleDiscordId.guildId, where.guildId_roleDiscordId.roleDiscordId)) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = key(where.guildId_roleDiscordId.guildId, where.guildId_roleDiscordId.roleDiscordId);
        const previous = roleRows.get(k);
        const row = { ...(previous ?? create), ...(previous ? update : {}), updatedAt: new Date() };
        roleRows.set(k, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        const k = key(where.guildId_roleDiscordId.guildId, where.guildId_roleDiscordId.roleDiscordId);
        const previous = roleRows.get(k);
        roleRows.delete(k);
        return previous;
      }),
    };
  }

  const prisma: any = {
    __userRows: userRows,
    __roleRows: roleRows,
    __reset: () => {
      userRows.clear();
      roleRows.clear();
      lockTail = Promise.resolve();
    },
  };

  prisma.$transaction = jest.fn(async (callback: any) => {
    let release: (() => void) | null = null;
    let acquired = false;
    const tx: any = {
      guildPermissionGrant: userModel(),
      guildPermissionRoleGrant: roleModel(),
      $queryRaw: jest.fn(async () => {
        const previous = lockTail;
        lockTail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        acquired = true;
        return [];
      }),
    };
    try {
      return await callback(tx);
    } finally {
      if (acquired && release) release();
    }
  });

  return { __esModule: true, default: prisma };
});

import prisma from '../../src/database/prisma';
import { asGuildId, asUserDiscordId } from '../../src/types/scope';
import { mutatePermissionGrant } from '../../src/modules/permissions/mutationService';

const db = prisma as any;
const GUILD = asGuildId('123456789012345678');
const ACTOR = asUserDiscordId('223456789012345678');
const USER = '323456789012345678';
const ROLE = '423456789012345678';
const userKey = `${GUILD}:${USER}`;
const roleKey = `${GUILD}:${ROLE}`;

beforeEach(() => {
  jest.clearAllMocks();
  db.__reset();
});

describe('permission mutation service', () => {
  test('two parallel grants on the same user both survive', async () => {
    await Promise.all([
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'GRANT', permission: 'dashboard.view', grantedBy: ACTOR }),
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'GRANT', permission: 'economy.view', grantedBy: ACTOR }),
    ]);

    expect(db.__userRows.get(userKey).permissions).toEqual(['dashboard.view', 'economy.view']);
  });

  test('parallel grant and revoke have a valid serialized result without lost update', async () => {
    db.__userRows.set(userKey, {
      guildId: GUILD,
      userDiscordId: USER,
      permissions: ['dashboard.view'],
      grantedByDiscordId: ACTOR,
    });

    await Promise.all([
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'GRANT', permission: 'economy.view', grantedBy: ACTOR }),
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'REVOKE', permission: 'dashboard.view', grantedBy: ACTOR }),
    ]);

    expect(db.__userRows.get(userKey)?.permissions).toEqual(['economy.view']);
  });

  test('last user scope revoke deletes the row and next grant starts clean', async () => {
    db.__userRows.set(userKey, {
      guildId: GUILD,
      userDiscordId: USER,
      permissions: ['dashboard.view'],
      grantedByDiscordId: ACTOR,
    });

    const revoke = await mutatePermissionGrant({
      guildId: GUILD, targetKind: 'USER', targetId: USER,
      action: 'REVOKE', permission: 'dashboard.view', grantedBy: ACTOR,
    });
    expect(revoke.permissions).toEqual([]);
    expect(db.__userRows.has(userKey)).toBe(false);

    await mutatePermissionGrant({
      guildId: GUILD, targetKind: 'USER', targetId: USER,
      action: 'GRANT', permission: 'economy.view', grantedBy: ACTOR,
    });
    expect(db.__userRows.get(userKey).permissions).toEqual(['economy.view']);
  });

  test('next mutation removes corrupt unknown and non-delegable stored scopes', async () => {
    db.__userRows.set(userKey, {
      guildId: GUILD,
      userDiscordId: USER,
      permissions: ['dashboard.view', 'permissions.manage', 'unknown.scope'],
      grantedByDiscordId: ACTOR,
    });

    await mutatePermissionGrant({
      guildId: GUILD, targetKind: 'USER', targetId: USER,
      action: 'GRANT', permission: 'economy.view', grantedBy: ACTOR,
    });

    expect(db.__userRows.get(userKey).permissions).toEqual(['dashboard.view', 'economy.view']);
  });

  test('role mutations use the same lifecycle and last revoke deletes the row', async () => {
    await mutatePermissionGrant({
      guildId: GUILD, targetKind: 'ROLE', targetId: ROLE,
      action: 'GRANT', permission: 'tickets.manage', grantedBy: ACTOR,
    });
    expect(db.__roleRows.get(roleKey).permissions).toEqual(['tickets.manage']);

    await mutatePermissionGrant({
      guildId: GUILD, targetKind: 'ROLE', targetId: ROLE,
      action: 'REVOKE', permission: 'tickets.manage', grantedBy: ACTOR,
    });
    expect(db.__roleRows.has(roleKey)).toBe(false);
  });

  test('parallel purge and grant never resurrect pre-existing scopes outside a serial outcome', async () => {
    db.__userRows.set(userKey, {
      guildId: GUILD,
      userDiscordId: USER,
      permissions: ['dashboard.view'],
      grantedByDiscordId: ACTOR,
    });

    await Promise.all([
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'PURGE', grantedBy: ACTOR }),
      mutatePermissionGrant({ guildId: GUILD, targetKind: 'USER', targetId: USER, action: 'GRANT', permission: 'economy.view', grantedBy: ACTOR }),
    ]);

    const permissions = db.__userRows.get(userKey)?.permissions ?? [];
    expect([[], ['economy.view']]).toContainEqual(permissions);
    expect(permissions).not.toContain('dashboard.view');
  });
});
