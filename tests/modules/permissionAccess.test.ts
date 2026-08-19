const directFindUnique = jest.fn();
const roleFindMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildPermissionGrant: { findUnique: (...args: unknown[]) => directFindUnique(...args) },
    guildPermissionRoleGrant: { findMany: (...args: unknown[]) => roleFindMany(...args) },
  },
}));

import {
  delegatedPermissionSet,
  directGrantBelongsToMembership,
  resolveDelegatedPermissionContext,
} from '../../src/modules/permissions/access';

const GUILD_ID = '123456789012345678';
const USER_ID = '111111111111111111';
const ROLE_ID = '222222222222222222';
const JOINED_AT = new Date('2026-08-20T00:00:00.000Z');

function guildWith(member: unknown | null) {
  return {
    id: GUILD_ID,
    members: {
      cache: { get: jest.fn(() => member) },
      fetch: jest.fn(async () => member),
    },
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  directFindUnique.mockResolvedValue(null);
  roleFindMany.mockResolvedValue([]);
});

describe('canonical delegated permission access', () => {
  test('stale Direct-Grant is never read when the user is no longer a guild member', async () => {
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'], updatedAt: new Date() });

    const result = await resolveDelegatedPermissionContext(guildWith(null), USER_ID);

    expect(result.member).toBeNull();
    expect(result.permissions.size).toBe(0);
    expect(directFindUnique).not.toHaveBeenCalled();
    expect(roleFindMany).not.toHaveBeenCalled();
  });

  test('combines a current-epoch direct grant and current-role grants only after membership is proven', async () => {
    const member = { joinedAt: JOINED_AT, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view'],
      updatedAt: new Date('2026-08-20T00:00:01.000Z'),
    });
    roleFindMany.mockResolvedValue([{ permissions: ['whitelist.view'] }]);

    const result = await resolveDelegatedPermissionContext(guildWith(member), USER_ID);

    expect(result.member).toBe(member);
    expect([...result.permissions].sort()).toEqual(['economy.view', 'whitelist.view']);
    expect(directFindUnique).toHaveBeenCalledWith({
      where: { guildId_userDiscordId: { guildId: GUILD_ID, userDiscordId: USER_ID } },
      select: { permissions: true, updatedAt: true },
    });
    expect(roleFindMany).toHaveBeenCalledWith({
      where: { guildId: GUILD_ID, roleDiscordId: { in: [ROLE_ID] } },
      select: { permissions: true },
    });
  });

  test('old direct grant is ignored after rejoin even if cleanup row still exists', async () => {
    const member = { joinedAt: JOINED_AT, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    directFindUnique.mockResolvedValue({
      permissions: ['economy.view'],
      updatedAt: new Date('2026-08-19T23:59:59.000Z'),
    });
    roleFindMany.mockResolvedValue([{ permissions: ['whitelist.view'] }]);

    const result = await resolveDelegatedPermissionContext(guildWith(member), USER_ID);

    expect([...result.permissions]).toEqual(['whitelist.view']);
    expect(result.permissions.has('economy.view')).toBe(false);
  });

  test('missing joinedAt fails direct grants closed while live role grants still work', async () => {
    const member = { joinedAt: null, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    directFindUnique.mockResolvedValue({ permissions: ['economy.view'], updatedAt: new Date() });
    roleFindMany.mockResolvedValue([{ permissions: ['whitelist.view'] }]);

    const result = await resolveDelegatedPermissionContext(guildWith(member), USER_ID);

    expect([...result.permissions]).toEqual(['whitelist.view']);
  });

  test('membership epoch helper is inclusive for a grant written at joinedAt and rejects pre-join state', () => {
    expect(directGrantBelongsToMembership(new Date(JOINED_AT), JOINED_AT)).toBe(true);
    expect(directGrantBelongsToMembership(new Date(JOINED_AT.getTime() + 1), JOINED_AT)).toBe(true);
    expect(directGrantBelongsToMembership(new Date(JOINED_AT.getTime() - 1), JOINED_AT)).toBe(false);
    expect(directGrantBelongsToMembership(new Date(), null)).toBe(false);
  });

  test('drops unknown and non-delegable legacy values fail-closed', () => {
    const scopes = delegatedPermissionSet([
      'economy.view',
      'permissions.manage',
      'nitrado.manage',
      'nitrado.danger',
      'dev.console',
      'totally.unknown',
      123,
    ]);

    expect([...scopes]).toEqual(['economy.view']);
  });
});
