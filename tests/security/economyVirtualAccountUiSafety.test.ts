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
  const terminal = read('src/dashboard/routes/v2/economyVirtualAccountTerminalDeletion.ts');

  it('Dashboard haelt Systemkonten aus der generischen Kontenverwaltung heraus', () => {
    expect(panel).toContain("account.kind !== 'LOTTERY_POT'");
    expect(panel).toContain("account.kind !== 'MARKET_VENDOR'");
    expect(control).toContain("account.kind !== 'CUSTOM'");
  });

  it('Dashboard bietet Wallet, Bank, Waehrung, Manager, Live-Sync und den gemeinsamen Konten-Workspace', () => {
    expect(workspace).toContain('<VirtualAccountsControlPanel');
    expect(workspace).toContain('guildId={guildId}');
    expect(workspace).toContain('slot={slot}');
    expect(workspace).toContain('<SystemAccountsOverview guildId={guildId} slot={slot} onConfigureServerBank={() => setOpenTreasuryConfiguration(true)} />');
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
    expect(panel).toContain("account.kind !== 'LOTTERY_POT'");
    expect(panel).toContain("account.kind !== 'MARKET_VENDOR'");
    expect(panel).toContain('editingId === treasury.id');
    expect(panel).toContain('<AccountEditor account={treasury}');
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
    const terminalManage = (terminal.match(/requireGuildPermission\('economy\.manage'\)/g) ?? []).length;
    expect(legacyManage).toBeGreaterThanOrEqual(2);
    expect(controlManage).toBeGreaterThanOrEqual(4);
    expect(terminalManage).toBeGreaterThanOrEqual(5);
  });
});
