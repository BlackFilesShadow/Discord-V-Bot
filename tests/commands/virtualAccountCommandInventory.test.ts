import { DASHBOARD_EXTRA, SPEC_KEEP_COMMANDS, classifyCommand } from '../../src/commands/inventory';

// Cross-Check 2026-09: die Dashboard-Payout-Routen fuer virtuelle Konten
// bewegen Geld in die GEGENTEILIGE Richtung (Konto -> Mitglied, nur Staff)
// verglichen mit dem Discord-Command `pay` (Mitglied -> Konto, Selbstbedienung
// per safeDepositUserIntoVirtualAccount()). Keine Dashboard-Route ruft diese
// Funktion auf - es besteht keine echte Paritaet, nur zwei verschiedene
// Operationen auf demselben Datenmodell.
it('haelt /virtual-account als sichtbaren Economy-User-Command ohne Dashboard-Ersatz fuer die Selbstbedienungs-Einzahlung', () => {
  expect(SPEC_KEEP_COMMANDS.has('virtual-account')).toBe(true);
  expect(DASHBOARD_EXTRA.has('virtual-account')).toBe(false);
  expect(classifyCommand({ name: 'virtual-account', source: 'dashboard/virtualAccounts.ts' })).toMatchObject({
    category: 'keep',
    target: 'discord',
    migrationStatus: 'active',
    dashboardReplacement: false,
    staysInDiscord: true,
  });
});
