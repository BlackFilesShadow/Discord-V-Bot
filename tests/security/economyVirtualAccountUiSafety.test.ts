import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Konten — Surface-Sicherheit', () => {
  const panel = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
  const command = read('src/commands/dashboard/virtualAccounts.ts');
  const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');

  it('Dashboard verhindert Archivierung sichtbar bei Restguthaben', () => {
    expect(panel).toContain('disabled={archive.isPending || BigInt(account.balance) !== 0n}');
    expect(panel).toContain('Nur Konten mit 0 Guthaben koennen archiviert werden.');
  });

  it('Dashboard bietet kontrollierte Auszahlung und keine physische Loeschung', () => {
    expect(panel).toContain('Kontrollierte Auszahlung / Refund');
    expect(panel).toContain('/payout`');
    expect(panel).not.toMatch(/api\.del\([^\n]*virtual-accounts/);
  });

  it('Discord erlaubt Usern nur Liste, Info und Einzahlung', () => {
    expect(command).toContain(".setName('list')");
    expect(command).toContain(".setName('info')");
    expect(command).toContain(".setName('pay')");
    expect(command).not.toContain(".setName('archive')");
    expect(command).not.toContain(".setName('payout')");
  });

  it('Dashboard-Mutationen bleiben economy.manage-geschuetzt', () => {
    const manageOccurrences = (route.match(/requireGuildPermission\('economy\.manage'\)/g) ?? []).length;
    expect(manageOccurrences).toBeGreaterThanOrEqual(3);
  });
});
