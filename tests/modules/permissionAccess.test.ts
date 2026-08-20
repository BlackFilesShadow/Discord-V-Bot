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
  directGrantMembershipEpoch,
  membershipEpochMarker,
  resolveDelegatedPermissionContext,
  storedDirectPermissions,
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

  test('combines an explicit current-epoch direct grant and current-role grants only after membership is proven', async () => {
    const member = { joinedAt: JOINED_AT, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
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

  test('explicit old membership marker wins over a fresh updatedAt and is ignored after rejoin', async () => {
    const member = { joinedAt: JOINED_AT, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    const OLD_JOIN = new Date('2026-08-19T20:00:00.000Z');
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], OLD_JOIN),
      // Simuliert einen spaeten/stalen Write: updatedAt allein darf die alte
      // Mitgliedschaft nach Einfuehrung des Markers nicht reaktivieren.
      updatedAt: new Date('2026-08-20T00:00:05.000Z'),
    });
    roleFindMany.mockResolvedValue([{ permissions: ['whitelist.view'] }]);

    const result = await resolveDelegatedPermissionContext(guildWith(member), USER_ID);

    expect([...result.permissions]).toEqual(['whitelist.view']);
    expect(result.permissions.has('economy.view')).toBe(false);
  });

  test('legacy direct grant without marker uses conservative updatedAt fallback once', () => {
    expect(directGrantBelongsToMembership(
      ['economy.view'],
      new Date(JOINED_AT.getTime() + 1),
      JOINED_AT,
    )).toBe(true);
    expect(directGrantBelongsToMembership(
      ['economy.view'],
      new Date(JOINED_AT.getTime() - 1),
      JOINED_AT,
    )).toBe(false);
  });

  test('missing joinedAt fails direct grants closed while live role grants still work', async () => {
    const member = { joinedAt: null, roles: { cache: new Map<string, unknown>([[ROLE_ID, {}]]) } };
    directFindUnique.mockResolvedValue({
      permissions: storedDirectPermissions(['economy.view'], JOINED_AT),
      updatedAt: new Date(),
    });
    roleFindMany.mockResolvedValue([{ permissions: ['whitelist.view'] }]);

    const result = await resolveDelegatedPermissionContext(guildWith(member), USER_ID);

    expect([...result.permissions]).toEqual(['whitelist.view']);
  });

  test('membership marker helper requires exactly one canonical ISO marker and malformed marker state never falls back to updatedAt', () => {
    const marker = membershipEpochMarker(JOINED_AT);
    const duplicateMarkers = [marker, marker, 'economy.view'];
    const malformedMarker = ['__vbot_membership_joined_at:not-a-date', 'economy.view'];
    const freshUpdatedAt = new Date(JOINED_AT.getTime() + 60_000);

    expect(marker).toBe('__vbot_membership_joined_at:2026-08-20T00:00:00.000Z');
    expect(directGrantMembershipEpoch([marker, 'economy.view'])?.getTime()).toBe(JOINED_AT.getTime());
    expect(directGrantMembershipEpoch(duplicateMarkers)).toBeNull();
    expect(directGrantMembershipEpoch(malformedMarker)).toBeNull();
    expect(directGrantBelongsToMembership(duplicateMarkers, freshUpdatedAt, JOINED_AT)).toBe(false);
    expect(directGrantBelongsToMembership(malformedMarker, freshUpdatedAt, JOINED_AT)).toBe(false);
  });

  test('explicit membership epoch must exactly match current joinedAt', () => {
    const current = storedDirectPermissions(['economy.view'], JOINED_AT);
    const older = storedDirectPermissions(['economy.view'], new Date(JOINED_AT.getTime() - 1000));

    expect(directGrantBelongsToMembership(current, new Date(), JOINED_AT)).toBe(true);
    expect(directGrantBelongsToMembership(older, new Date(JOINED_AT.getTime() + 5000), JOINED_AT)).toBe(false);
    expect(directGrantBelongsToMembership(current, new Date(), null)).toBe(false);
  });

  test('drops unknown, non-delegable and internal marker values fail-closed', () => {
    const scopes = delegatedPermissionSet([
      membershipEpochMarker(JOINED_AT),
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
