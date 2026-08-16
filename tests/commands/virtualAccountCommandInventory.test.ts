import { DASHBOARD_EXTRA, SPEC_KEEP_COMMANDS, classifyCommand } from '../../src/commands/inventory';

it('haelt /virtual-account als sichtbaren Economy-User-Command mit Dashboard-Paritaet', () => {
  expect(SPEC_KEEP_COMMANDS.has('virtual-account')).toBe(true);
  expect(DASHBOARD_EXTRA.has('virtual-account')).toBe(true);
  expect(classifyCommand({ name: 'virtual-account', source: 'dashboard/virtualAccounts.ts' })).toMatchObject({
    category: 'keep',
    target: 'discord',
    migrationStatus: 'active',
    dashboardReplacement: true,
    staysInDiscord: true,
  });
});
