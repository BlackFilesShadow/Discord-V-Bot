import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Konten — Surface-Sicherheit', () => {
  const panel = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
  const workspace = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
  const command = read('src/commands/dashboard/virtualAccounts.ts');
  const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
  const control = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');

  it('Dashboard verhindert Archivierung sichtbar bei Wallet- oder Bank-Restguthaben', () => {
    expect(panel).toContain("BigInt(account.walletBalance) === 0n && BigInt(account.bankBalance) === 0n");
    expect(panel).toContain('Archivieren erst bei Wallet=0 und Bank=0 möglich.');
    expect(control).toContain("account.kind !== 'CUSTOM'");
  });

  it('Dashboard bietet Wallet, Bank, Waehrung, Manager, Live-Sync und den gemeinsamen Konten-Workspace', () => {
    expect(workspace).toContain('<VirtualAccountsControlPanel guildId={guildId} slot={slot} />');
    expect(workspace).toContain('<SystemAccountsOverview guildId={guildId} slot={slot} />');
    expect(workspace).toContain('<LotteryPanel guildId={guildId} slot={slot} />');
    expect(workspace).toContain('<BlackMarketPanel guildId={guildId} slot={slot} />');
    expect(panel).toContain('walletBalance');
    expect(panel).toContain('bankBalance');
    expect(panel).toContain('currencyName');
    expect(panel).toContain('Kontoverwalter');
    expect(panel).toContain('Management-Kanal');
    expect(panel).toContain('/control/accounts');
    expect(panel).toContain('/control/manager-panel');
    expect(panel).toContain("['economy-virtual-account-audit', guildId, slot, auditAccountId]");
    expect(panel).not.toMatch(/api\.del\([^\n]*virtual-accounts/);
  });

  it('Dashboard erhaelt die kontrollierte Admin-Auszahlung und expliziten Pocket-Kontext', () => {
    expect(panel).toContain('Admin-Auszahlung');
    expect(panel).toContain('sourcePocket');
    expect(panel).toContain('targetPocket');
    expect(panel).toContain('/payout?slot=${encodeURIComponent(slot)}');
  });

  it('Discord erlaubt Usern nur Liste, Info und Einzahlung', () => {
    expect(command).toContain(".setName('list')");
    expect(command).toContain(".setName('info')");
    expect(command).toContain(".setName('pay')");
    expect(command).not.toContain(".setName('archive')");
    expect(command).not.toContain(".setName('payout')");
  });

  it('Dashboard-Mutationen bleiben economy.manage-geschuetzt', () => {
    const legacyManage = (route.match(/requireGuildPermission\('economy\.manage'\)/g) ?? []).length;
    const controlManage = (control.match(/requireGuildPermission\('economy\.manage'\)/g) ?? []).length;
    expect(legacyManage).toBeGreaterThanOrEqual(3);
    expect(controlManage).toBeGreaterThanOrEqual(4);
  });
});
