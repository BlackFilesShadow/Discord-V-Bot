import fs from 'node:fs';
import path from 'node:path';

const v2 = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dashboard', 'routes', 'v2.ts'), 'utf8');

it('mountet virtuelle Economy-Konten ausschliesslich hinter Domain-Auth und sicherem Gameserver-Scope', () => {
  const expected = "v2Router.use('/guilds/:guildId/economy/virtual-accounts', requireEconomyDashboardAccess, requireSafeDashboardEconomyScope, economyVirtualAccountsRouter);";
  expect(v2).toContain(expected);
  expect(v2).not.toContain("v2Router.use('/guilds/:guildId/economy/virtual-accounts', economyVirtualAccountsRouter)");
});
