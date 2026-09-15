import { DASHBOARD_EXTRA, SPEC_KEEP_COMMANDS, classifyCommand } from '../../src/commands/inventory';

// Cross-Check 2026-09: das Dashboard bietet fuer /lottery keinen Ticket-Kauf,
// nur Admin-Rundenverwaltung (Erstellen/Beenden) und eine Verlaufsansicht.
// buyLotteryTickets() wird ausschliesslich vom Discord-Command und einem
// Discord-Button-Handler aufgerufen, nie von einer Dashboard-Route. /lottery
// bleibt deshalb ein reiner Discord-Command ohne Dashboard-Paritaet.
it('haelt /lottery als sichtbaren Economy-User-Command ohne Dashboard-Ersatz fuer den Ticket-Kauf', () => {
  expect(SPEC_KEEP_COMMANDS.has('lottery')).toBe(true);
  expect(DASHBOARD_EXTRA.has('lottery')).toBe(false);
  expect(classifyCommand({ name: 'lottery', source: 'dashboard/lottery.ts' })).toMatchObject({
    category: 'keep',
    target: 'discord',
    migrationStatus: 'active',
    dashboardReplacement: false,
    staysInDiscord: true,
  });
});