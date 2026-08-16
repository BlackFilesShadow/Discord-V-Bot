import { DASHBOARD_EXTRA, SPEC_KEEP_COMMANDS, classifyCommand } from '../../src/commands/inventory';

it('haelt /lottery als sichtbaren Economy-User-Command mit Dashboard-Paritaet', () => {
  expect(SPEC_KEEP_COMMANDS.has('lottery')).toBe(true);
  expect(DASHBOARD_EXTRA.has('lottery')).toBe(true);
  expect(classifyCommand({ name: 'lottery', source: 'dashboard/lottery.ts' })).toMatchObject({
    category: 'keep',
    target: 'discord',
    migrationStatus: 'active',
    dashboardReplacement: true,
    staysInDiscord: true,
  });
});