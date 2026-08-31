import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtual account removal regression', () => {
  const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
  const control = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
  const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
  const migration = read('prisma/migrations/20260829095500_virtual_account_control_hidden/migration.sql');

  it('allows every visible state to be removed without destroying domain-owned accounts', () => {
    expect(deletion).toContain("account.kind === 'LOTTERY_POT' || account.kind === 'MARKET_VENDOR'");
    expect(deletion).toContain('return hideDomainOwnedAccount');
    expect(deletion).toContain("account.kind !== 'CUSTOM'");
    expect(deletion).toContain("mode: 'CONTROL_HIDDEN'");
    expect(deletion).toContain("mode: 'HARD_DELETED'");
    expect(deletion).not.toContain("account.status !== 'ARCHIVED'");
  });

  it('zeroes non-empty CUSTOM pockets atomically with audit entries and frees deleted treasury identity', () => {
    expect(deletion).toContain("'CONTROL_DELETE_RESET'");
    expect(deletion).toContain('args.account.balance > 0n');
    expect(deletion).toContain('args.finance.bankBalance > 0n');
    expect(deletion).toContain('SET "bankBalance"=0');
    expect(deletion).toContain('SET "balance"=0');
    expect(deletion).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(deletion).toContain('const mustPreserveRow = hasMoney');
  });

  it('never destroys lottery, market or ledger history to make an account disappear', () => {
    expect(deletion).toContain('"LotteryRound"');
    expect(deletion).toContain('"EconomyMarketListing"');
    expect(deletion).toContain('"EconomyMarketPurchase"');
    expect(deletion).toContain('"EconomyVirtualAccountControlHidden"');
    expect(deletion).not.toContain('DELETE FROM "LotteryRound"');
    expect(deletion).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketPurchase"');
  });

  it('stores a scoped tombstone with account FK and hides it from the control list', () => {
    expect(migration).toContain('CREATE TABLE "EconomyVirtualAccountControlHidden"');
    expect(migration).toContain('FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")');
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(control).toContain('listHiddenVirtualAccountIds');
    expect(control).toContain('accounts.filter(account => !hiddenIds.has(account.id))');
  });

  it('shows one two-click delete action next to Audit for all account kinds/statuses/balances', () => {
    expect(ui).toContain('<History className="h-3.5 w-3.5 mr-1" />Audit');
    expect(ui).toContain("'Wirklich löschen?' : 'Löschen'");
    expect(ui).toContain('disabled={remove.isPending || archive.isPending}');
    expect(ui).not.toContain('const deleteSupported =');
    expect(ui).not.toContain('const canDelete =');
    expect(ui).toContain('unabhängig von Status und Kontostand');
  });
});
