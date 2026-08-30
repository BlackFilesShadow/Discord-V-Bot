import fs from 'node:fs';
import path from 'node:path';
import {
  asGuildId,
  asUserDiscordId,
  effectiveDashboardPermissions,
  hasPermission,
  type GuildScope,
  type PermissionScope,
} from '../../src/types/scope';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function delegatedScope(...permissions: PermissionScope[]): GuildScope {
  return {
    guildId: asGuildId('123456789012345678'),
    nitradoConnId: null,
    actorDiscordId: asUserDiscordId('223456789012345678'),
    isOwner: false,
    permissions: new Set(permissions),
  };
}

describe('Dashboard full access contract', () => {
  it('keeps non-delegable scope identities protected while dashboard.access remains the explicit guild-dashboard master grant', () => {
    const scope = delegatedScope('dashboard.access');

    expect(hasPermission(scope, 'killfeed.view')).toBe(true);
    expect(hasPermission(scope, 'killfeed.manage')).toBe(true);
    expect(hasPermission(scope, 'economy.view')).toBe(true);
    expect(hasPermission(scope, 'economy.manage')).toBe(true);
    expect(hasPermission(scope, 'casino.view')).toBe(true);
    expect(hasPermission(scope, 'casino.manage')).toBe(true);

    // Diese Scope-Namen bleiben absichtlich nicht direkt durch dashboard.access
    // geerbt. Owner-aehnliche Guild-Dashboard-Seiten verwenden stattdessen
    // explizit requireGuildPermission('dashboard.access'). So werden die
    // sensiblen Scope-IDs nicht ploetzlich selbst delegierbar.
    expect(hasPermission(scope, 'nitrado.manage')).toBe(false);
    expect(hasPermission(scope, 'nitrado.danger')).toBe(false);
    expect(hasPermission(scope, 'permissions.manage')).toBe(false);
    expect(hasPermission(scope, 'dev.console')).toBe(false);
  });

  it('publishes effective delegable scopes to dashboard UI without exposing protected scope identities', () => {
    const effective = effectiveDashboardPermissions(delegatedScope('dashboard.access'));

    expect(effective).toEqual(expect.arrayContaining([
      'dashboard.access',
      'dashboard.view',
      'whitelist.view',
      'whitelist.manage',
      'economy.view',
      'economy.manage',
      'casino.view',
      'casino.manage',
      'killfeed.view',
      'killfeed.manage',
      'factions.view',
      'factions.manage',
      'welcome.view',
      'welcome.manage',
    ]));
    expect(effective).not.toContain('nitrado.manage');
    expect(effective).not.toContain('nitrado.danger');
    expect(effective).not.toContain('permissions.manage');
    expect(effective).not.toContain('dev.console');

    const dashboardRoute = read('src/dashboard/routes/v2/dashboard.ts');
    expect(dashboardRoute).toContain('permissions: effectiveDashboardPermissions(scope)');
  });

  it('protects every ADM source Page-2 operation with killfeed.manage instead of owner-only auth', () => {
    const adm = read('src/dashboard/routes/v2/admSource.ts');

    expect(adm).toContain("import { requireGuildPermission } from '../../middleware/auth';");
    expect(adm).not.toContain('requireGuildOwner');
    expect((adm.match(/requireGuildPermission\('killfeed\.manage'\)/g) ?? []).length).toBe(3);
    expect(adm).toContain("admSourceRouter.get('/', requireGuildPermission('killfeed.manage')");
    expect(adm).toContain("admSourceRouter.patch('/', requireGuildPermission('killfeed.manage')");
    expect(adm).toContain("admSourceRouter.post('/rediscover', requireGuildPermission('killfeed.manage')");
  });

  it('keeps Economy config, lottery and virtual-account control on delegable economy scopes', () => {
    const economy = read('src/dashboard/routes/v2/economy.ts');
    const lottery = read('src/dashboard/routes/v2/economyLottery.ts');
    const virtualAccounts = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
    const lotteryUi = read('dashboard-ui/src/components/economy/LotteryPanel.tsx');
    const blackMarketUi = read('dashboard-ui/src/components/economy/BlackMarketPanel.tsx');

    expect(economy).toContain("economyRouter.get('/config', requireGuildPermission('economy.view')");
    expect(economy).toContain("economyRouter.put('/config', requireGuildPermission('economy.manage')");
    expect(economy).toContain("economyRouter.get('/overview', requireGuildPermission('economy.view')");
    expect(economy).toContain("economyRouter.post('/accounts/:userDiscordId/admin-pay', requireGuildPermission('economy.manage')");

    expect(lottery).toContain("economyLotteryRouter.get('/current', requireGuildPermission('economy.view')");
    expect(lottery).toContain("economyLotteryRouter.post('/rounds', requireGuildPermission('economy.manage')");

    expect(virtualAccounts).toContain("economyVirtualAccountControlRouter.get('/control/accounts', requireGuildPermission('economy.view')");
    expect(virtualAccounts).toContain("economyVirtualAccountControlRouter.post('/control/accounts', requireGuildPermission('economy.manage')");

    expect(lotteryUi).toContain("permissions.includes('economy.manage')");
    expect(blackMarketUi).toContain("permissions.includes('economy.manage')");
  });

  it('opens all Nitrado Page-1 slot/token/service/alias operations to explicit dashboard.access', () => {
    const nitrado = read('src/dashboard/routes/v2/nitrado.ts');

    expect(nitrado).toContain('Guild-Owner oder expliziter dashboard.access-Vollzugriff');
    expect(nitrado).toContain("import { requireGuildPermission } from '../../middleware/auth';");
    expect(nitrado).not.toContain('requireGuildOwner');
    expect((nitrado.match(/requireGuildPermission\('dashboard\.access'\)/g) ?? []).length).toBe(7);
    expect(nitrado).toContain("nitradoRouter.get('/', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.post('/', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.patch('/:slot/token', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.patch('/:slot/alias', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.patch('/:slot/service', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.delete('/:slot', requireGuildPermission('dashboard.access')");
    expect(nitrado).toContain("nitradoRouter.get('/:slot/services', requireGuildPermission('dashboard.access')");
  });

  it('opens permission administration, guild audit and leave-cleanup controls to the same explicit dashboard.access gate', () => {
    const permissions = read('src/dashboard/routes/v2/permissions.ts');
    const audit = read('src/dashboard/routes/v2/audit.ts');
    const cleanup = read('src/dashboard/routes/v2/leaveCleanup.ts');

    for (const source of [permissions, audit, cleanup]) {
      expect(source).toContain("requireGuildPermission('dashboard.access')");
      expect(source).not.toContain('requireGuildOwner');
    }

    expect((permissions.match(/requireGuildPermission\('dashboard\.access'\)/g) ?? []).length).toBe(7);
    expect((audit.match(/requireGuildPermission\('dashboard\.access'\)/g) ?? []).length).toBe(2);
    expect((cleanup.match(/requireGuildPermission\('dashboard\.access'\)/g) ?? []).length).toBe(2);

    expect(permissions).toContain('NON_DELEGABLE_SCOPES.has(perm)');
    expect(permissions).toContain('availableScopes: PERMISSION_SCOPES.filter(s => !NON_DELEGABLE_SCOPES.has(s))');
  });

  it('shows every guild-dashboard tab and Page-1 controls for dashboard.access without faking actual Discord ownership', () => {
    const ui = read('dashboard-ui/src/pages/Server.tsx');

    expect(ui).toContain("const hasFullAccess = isOwner || perms.includes('dashboard.access');");
    expect(ui).toContain('if (t.ownerOnly && !hasFullAccess) return false;');
    expect(ui).toContain('<NitradoTab guildId={guildId} canManage={hasFullAccess}');
    expect(ui).toContain("tab === 'aliases' && guildId && hasFullAccess");
    expect(ui).toContain("tab === 'permissions' && guildId && hasFullAccess");
    expect(ui).toContain("tab === 'audit' && guildId && hasFullAccess");
    expect(ui).toContain('{isOwner && (');
    expect(ui).not.toContain('<NitradoTab guildId={guildId} isOwner={isOwner}');
  });

  it('keeps global Bot-Admin, Dev and slash-command authorization outside dashboard.access', () => {
    const auth = read('src/dashboard/middleware/auth.ts');
    const scopeSource = read('src/types/scope.ts');

    expect(auth).toContain('export async function requireDev(');
    expect(auth).toContain('export async function requireBotAdmin(');
    expect(auth).toContain("if (req.auth.role !== 'DEVELOPER')");
    expect(auth).toContain('await requireDev(req, res, next);');
    expect(scopeSource).toContain('export function hasCommandPermission');
    expect(scopeSource).toContain('if (scope.permissions.has(perm)) return true;');
    expect(scopeSource).toContain("return scope.permissions.has('commands.all') && !NON_DELEGABLE_SCOPES.has(perm);");
  });

  it('keeps the Page-2 dashboard UI gate aligned with dashboard.access and exposes the Economy tab', () => {
    const ui = read('dashboard-ui/src/pages/ServerSlot.tsx');

    expect(ui).toContain("dashboardMeta.data?.permissions.includes('dashboard.access')");
    expect(ui).toContain("dashboardMeta.data?.permissions.includes('killfeed.manage')");
    expect(ui).toContain("['economy', 'Economy', Coins]");
  });
});
