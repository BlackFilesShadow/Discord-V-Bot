import fs from 'node:fs';
import path from 'node:path';

const v2 = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'dashboard', 'routes', 'v2.ts'), 'utf8');

it('mountet virtuelle Economy-Konten ausschliesslich hinter Domain-Auth und sicherem Gameserver-Scope', () => {
  const start = v2.indexOf("'/guilds/:guildId/economy/virtual-accounts'");
  expect(start).toBeGreaterThan(-1);
  const window = v2.slice(start, start + 500);
  expect(window).toContain('requireEconomyDashboardAccess');
  expect(window).toContain('requireSafeDashboardEconomyScope');
  expect(window).toContain('economyVirtualAccountTreasurySafetyRouter');
  expect(window).toContain('economyVirtualAccountControlRouter');
  expect(window).toContain('economyVirtualAccountsRouter');
  expect(v2).not.toContain("v2Router.use('/guilds/:guildId/economy/virtual-accounts', economyVirtualAccountsRouter)");
});
