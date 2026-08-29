import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('archived lottery pot delete regression', () => {
  const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
  const control = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
  const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
  const migration = read('prisma/migrations/20260829095500_virtual_account_control_hidden/migration.sql');

  it('keeps CUSTOM as hard delete while archived lottery pots are control-hidden', () => {
    expect(deletion).toContain("if (account.kind !== 'CUSTOM')");
    expect(deletion).toContain("if (account.kind !== 'LOTTERY_POT')");
    expect(deletion).toContain("if (account.status !== 'ARCHIVED')");
    expect(deletion).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(deletion).toContain("mode: 'CONTROL_HIDDEN'");
    expect(deletion).toContain("mode: 'HARD_DELETED'");
  });

  it('never destroys lottery history to make the account disappear', () => {
    expect(deletion).toContain('"LotteryRound"');
    expect(deletion).toContain("'FINISHED'::\"LotteryRoundStatus\"");
    expect(deletion).toContain("'REFUNDED'::\"LotteryRoundStatus\"");
    expect(deletion).toContain('"EconomyVirtualAccountControlHidden"');
    expect(deletion).not.toContain('DELETE FROM "LotteryRound"');
    expect(deletion).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
  });

  it('stores a scoped tombstone with account FK and hides it from the control list', () => {
    expect(migration).toContain('CREATE TABLE "EconomyVirtualAccountControlHidden"');
    expect(migration).toContain('FOREIGN KEY ("accountId") REFERENCES "EconomyVirtualAccount"("id")');
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).toContain('"guildId" TEXT NOT NULL');
    expect(migration).toContain('"nitradoConnId" TEXT NOT NULL');
    expect(control).toContain('listHiddenVirtualAccountIds');
    expect(control).toContain('accounts.filter(account => !hiddenIds.has(account.id))');
  });

  it('shows the same two-click delete action for archived lottery pots without relabeling their kind', () => {
    expect(ui).toContain("account.kind === 'LOTTERY_POT' && account.status === 'ARCHIVED'");
    expect(ui).toContain('const deleteSupported = customDeleteSupported || archivedLotteryDeleteSupported;');
    expect(ui).toContain("'Wirklich löschen?' : 'Löschen'");
    expect(ui).toContain("result.deleted.mode === 'CONTROL_HIDDEN'");
    expect(ui).toContain('Historie und Audit bleiben erhalten.');
    expect(ui).toContain("<Badge variant=\"neutral\">{account.accountPurpose === 'BANK_TREASURY' ? 'SERVERBANK' : account.kind}</Badge>");
  });
});
