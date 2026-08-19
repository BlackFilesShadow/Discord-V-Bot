jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildPermissionGrant: { findUnique: jest.fn() },
    guildPermissionRoleGrant: { findMany: jest.fn() },
  },
}));

import prisma from '../../src/database/prisma';
import { resolveGuildPermissionAccess } from '../../src/modules/permissions/access';

const db = prisma as any;
const OWNER = '123456789012345678';
const USER = '223456789012345678';
const GUILD = '323456789012345678';
const ROLE_A = '423456789012345678';
const ROLE_B = '523456789012345678';
const MANAGED_ROLE = '623456789012345678';

function role(id: string, managed = false): any {
  return { id, managed };
}

function memberWithRoles(...roles: any[]): any {
  return { roles: { cache: new Map(roles.map(r => [r.id, r])) } };
}

function guildStub(options: { member?: any; ownerId?: string } = {}): any {
  const member = options.member;
  return {
    id: GUILD,
    ownerId: options.ownerId ?? OWNER,
    members: {
      cache: new Map(member ? [[USER, member]] : []),
      fetch: jest.fn().mockResolvedValue(member ?? null),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  db.guildPermissionGrant.findUnique.mockResolvedValue(null);
  db.guildPermissionRoleGrant.findMany.mockResolvedValue([]);
});

describe('canonical guild permission access', () => {
  test('stale direct grant cannot authorize a user who is no longer a guild member', async () => {
    const guild = guildStub();
    guild.members.fetch.mockResolvedValue(null);
    db.guildPermissionGrant.findUnique.mockResolvedValue({ permissions: ['dashboard.access'] });

    const access = await resolveGuildPermissionAccess(guild, USER);

    expect(access).toMatchObject({ isOwner: false, isMember: false, allowed: false });
    expect([...access.permissions]).toEqual([]);
    expect(db.guildPermissionGrant.findUnique).not.toHaveBeenCalled();
    expect(db.guildPermissionRoleGrant.findMany).not.toHaveBeenCalled();
  });

  test('unknown and non-delegable stored scopes never authorize a non-owner', async () => {
    const member = memberWithRoles(role(ROLE_A));
    const guild = guildStub({ member });
    db.guildPermissionGrant.findUnique.mockResolvedValue({
      permissions: ['permissions.manage', 'dev.console', 'unknown.scope'],
    });
    db.guildPermissionRoleGrant.findMany.mockResolvedValue([{ permissions: ['nitrado.danger'] }]);

    const access = await resolveGuildPermissionAccess(guild, USER);

    expect(access.isMember).toBe(true);
    expect(access.allowed).toBe(false);
    expect([...access.permissions]).toEqual([]);
  });

  test('known direct and current-role scopes are unioned and sanitized', async () => {
    const member = memberWithRoles(role(GUILD), role(ROLE_A), role(ROLE_B), role(MANAGED_ROLE, true));
    const guild = guildStub({ member });
    db.guildPermissionGrant.findUnique.mockResolvedValue({
      permissions: ['dashboard.view', 'permissions.manage', 'dashboard.view'],
    });
    db.guildPermissionRoleGrant.findMany.mockResolvedValue([
      { permissions: ['economy.view'] },
      { permissions: ['dashboard.view', 'fake.scope'] },
    ]);

    const access = await resolveGuildPermissionAccess(guild, USER);

    expect(access).toMatchObject({ isOwner: false, isMember: true, allowed: true });
    expect([...access.permissions].sort()).toEqual(['dashboard.view', 'economy.view']);
    expect(db.guildPermissionRoleGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: guild.id,
        roleDiscordId: { in: [ROLE_A, ROLE_B] },
      }),
    }));
  });

  test('@everyone and managed role grants can never authorize through legacy rows', async () => {
    const member = memberWithRoles(role(GUILD), role(MANAGED_ROLE, true));
    const guild = guildStub({ member });
    db.guildPermissionGrant.findUnique.mockResolvedValue({ permissions: [] });
    db.guildPermissionRoleGrant.findMany.mockResolvedValue([
      { permissions: ['dashboard.access'] },
    ]);

    const access = await resolveGuildPermissionAccess(guild, USER);

    expect(access.isMember).toBe(true);
    expect(access.allowed).toBe(false);
    expect([...access.permissions]).toEqual([]);
    expect(db.guildPermissionRoleGrant.findMany).not.toHaveBeenCalled();
  });

  test('owner remains authorized without delegated rows', async () => {
    const guild = guildStub({ ownerId: USER });
    const access = await resolveGuildPermissionAccess(guild, USER);
    expect(access).toMatchObject({ isOwner: true, isMember: true, allowed: true });
    expect(db.guildPermissionGrant.findUnique).not.toHaveBeenCalled();
  });
});
