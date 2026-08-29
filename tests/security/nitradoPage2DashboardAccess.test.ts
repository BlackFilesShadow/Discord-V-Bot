import fs from 'node:fs';
import path from 'node:path';
import {
  asGuildId,
  asUserDiscordId,
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

describe('Dashboard full access -> Nitrado Page 2 contract', () => {
  it('lets dashboard.access inherit Page-2 killfeed/ADM management but not owner-only Nitrado Page 1 powers', () => {
    const scope = delegatedScope('dashboard.access');

    expect(hasPermission(scope, 'killfeed.view')).toBe(true);
    expect(hasPermission(scope, 'killfeed.manage')).toBe(true);

    expect(hasPermission(scope, 'nitrado.manage')).toBe(false);
    expect(hasPermission(scope, 'nitrado.danger')).toBe(false);
    expect(hasPermission(scope, 'permissions.manage')).toBe(false);
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

  it('keeps Nitrado Page 1 token/service/slot administration owner-only', () => {
    const nitrado = read('src/dashboard/routes/v2/nitrado.ts');

    expect(nitrado).toContain('Nitrado-Slot-Verwaltung. NUR Owner — niemals delegierbar.');
    expect(nitrado).toContain("import { requireGuildOwner } from '../../middleware/auth';");
    expect(nitrado).toContain("nitradoRouter.post('/', requireGuildOwner");
    expect(nitrado).toContain("nitradoRouter.patch('/:slot/token', requireGuildOwner");
    expect(nitrado).toContain("nitradoRouter.patch('/:slot/service', requireGuildOwner");
    expect(nitrado).toContain("nitradoRouter.delete('/:slot', requireGuildOwner");
  });

  it('keeps the Page-2 dashboard UI gate aligned with dashboard.access', () => {
    const ui = read('dashboard-ui/src/pages/ServerSlot.tsx');

    expect(ui).toContain("dashboardMeta.data?.permissions.includes('dashboard.access')");
    expect(ui).toContain("dashboardMeta.data?.permissions.includes('killfeed.manage')");
  });
});
