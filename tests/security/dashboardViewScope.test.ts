/**
 * Production-Readiness: Absicherung des `dashboard.view`-Scopes.
 *
 * Stellt sicher, dass:
 *  - dashboard.view in PERMISSION_SCOPES existiert und delegierbar ist
 *  - hasPermission einen direkten dashboard.view-Grant akzeptiert
 *  - dashboard.access (All-Access-Bypass) dashboard.view abdeckt
 *  - nicht-delegierbare Scopes weiterhin Owner-only bleiben
 */
import {
  PERMISSION_SCOPES,
  NON_DELEGABLE_SCOPES,
  hasPermission,
  asGuildId,
  asUserDiscordId,
  type GuildScope,
  type PermissionScope,
} from '../../src/types/scope';

function makeScope(perms: PermissionScope[], isOwner = false): GuildScope {
  return {
    guildId: asGuildId('123456789012345678'),
    nitradoConnId: null,
    actorDiscordId: asUserDiscordId('987654321098765432'),
    isOwner,
    permissions: new Set<PermissionScope>(perms),
  };
}

describe('dashboard.view scope', () => {
  it('existiert in PERMISSION_SCOPES', () => {
    expect(PERMISSION_SCOPES).toContain('dashboard.view');
  });

  it('ist delegierbar (nicht in NON_DELEGABLE_SCOPES)', () => {
    expect(NON_DELEGABLE_SCOPES.has('dashboard.view')).toBe(false);
  });

  it('wird von hasPermission bei direktem Grant akzeptiert', () => {
    expect(hasPermission(makeScope(['dashboard.view']), 'dashboard.view')).toBe(true);
  });

  it('wird durch dashboard.access (All-Access) abgedeckt', () => {
    expect(hasPermission(makeScope(['dashboard.access']), 'dashboard.view')).toBe(true);
  });

  it('wird ohne passenden Grant abgelehnt', () => {
    expect(hasPermission(makeScope(['whitelist.view']), 'dashboard.view')).toBe(false);
  });

  it('haelt nicht-delegierbare Scopes trotz dashboard.access Owner-only', () => {
    const scope = makeScope(['dashboard.access']);
    expect(hasPermission(scope, 'nitrado.manage')).toBe(false);
    expect(hasPermission(scope, 'permissions.manage')).toBe(false);
    expect(hasPermission(scope, 'dev.console')).toBe(false);
  });

  it('Owner hat dashboard.view implizit', () => {
    expect(hasPermission(makeScope([], true), 'dashboard.view')).toBe(true);
  });
});
