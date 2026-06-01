/**
 * Production-Readiness: Absicherung der Bot-Admin-Scopes (`bot.view`/`bot.manage`/`bot.danger`).
 *
 * Stellt sicher, dass:
 *  - alle drei Scopes in PERMISSION_SCOPES existieren und delegierbar sind
 *  - hasPermission direkte Grants akzeptiert
 *  - dashboard.access (All-Access-Bypass) alle drei abdeckt
 *  - kein Bot-Admin-Scope den DEV-Scope (dev.console) freischaltet
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

const BOT_SCOPES: PermissionScope[] = ['bot.view', 'bot.manage', 'bot.danger'];

describe('Bot-Admin-Scopes', () => {
  it.each(BOT_SCOPES)('%s existiert in PERMISSION_SCOPES', (scope) => {
    expect(PERMISSION_SCOPES).toContain(scope);
  });

  it.each(BOT_SCOPES)('%s ist delegierbar (nicht in NON_DELEGABLE_SCOPES)', (scope) => {
    expect(NON_DELEGABLE_SCOPES.has(scope)).toBe(false);
  });

  it.each(BOT_SCOPES)('%s wird von hasPermission bei direktem Grant akzeptiert', (scope) => {
    expect(hasPermission(makeScope([scope]), scope)).toBe(true);
  });

  it.each(BOT_SCOPES)('%s wird durch dashboard.access (All-Access) abgedeckt', (scope) => {
    expect(hasPermission(makeScope(['dashboard.access']), scope)).toBe(true);
  });

  it('bot.view schaltet bot.manage/bot.danger NICHT frei', () => {
    const scope = makeScope(['bot.view']);
    expect(hasPermission(scope, 'bot.manage')).toBe(false);
    expect(hasPermission(scope, 'bot.danger')).toBe(false);
  });

  it('kein Bot-Admin-Scope schaltet dev.console frei', () => {
    expect(hasPermission(makeScope(BOT_SCOPES), 'dev.console')).toBe(false);
  });

  it('Owner hat alle Bot-Admin-Scopes implizit', () => {
    const owner = makeScope([], true);
    for (const scope of BOT_SCOPES) {
      expect(hasPermission(owner, scope)).toBe(true);
    }
  });
});
