import {
  hasCommandPermission,
  hasPermission,
  type GuildScope,
  type PermissionScope,
} from '../../src/types/scope';

function scope(perms: PermissionScope[]): GuildScope {
  return {
    guildId: '123456789012345678' as GuildScope['guildId'],
    nitradoConnId: null,
    actorDiscordId: '223456789012345678' as GuildScope['actorDiscordId'],
    isOwner: false,
    permissions: new Set(perms),
  };
}

describe('commands.all', () => {
  it('grants delegable command permissions', () => {
    const s = scope(['commands.all']);
    expect(hasCommandPermission(s, 'economy.manage')).toBe(true);
    expect(hasCommandPermission(s, 'whitelist.manage')).toBe(true);
    expect(hasCommandPermission(s, 'nitrado.write')).toBe(true);
  });

  it.each(['dev.console', 'nitrado.manage', 'nitrado.danger', 'permissions.manage'] as PermissionScope[])(
    'never overrides non-delegable scope %s',
    perm => {
      expect(hasCommandPermission(scope(['commands.all']), perm)).toBe(false);
    },
  );

  it('does not become a generic dashboard/REST bypass', () => {
    const s = scope(['commands.all']);
    expect(hasPermission(s, 'economy.manage')).toBe(false);
    expect(hasPermission(s, 'dashboard.access')).toBe(false);
  });

  it('does not let dashboard.access become a command bypass', () => {
    const s = scope(['dashboard.access']);
    expect(hasPermission(s, 'economy.manage')).toBe(true);
    expect(hasCommandPermission(s, 'economy.manage')).toBe(false);
    expect(hasCommandPermission(s, 'whitelist.manage')).toBe(false);
  });

  it('still accepts explicit command target scopes', () => {
    const s = scope(['economy.manage']);
    expect(hasCommandPermission(s, 'economy.manage')).toBe(true);
    expect(hasCommandPermission(s, 'whitelist.manage')).toBe(false);
  });

  it('keeps owner bypass intact', () => {
    const s = { ...scope([]), isOwner: true };
    expect(hasCommandPermission(s, 'dev.console')).toBe(true);
    expect(hasCommandPermission(s, 'nitrado.danger')).toBe(true);
  });
});
