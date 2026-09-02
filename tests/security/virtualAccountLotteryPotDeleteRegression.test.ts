import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtual account terminal removal regression', () => {
  const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
  const terminal = read('src/dashboard/routes/v2/economyVirtualAccountTerminalDeletion.ts');
  const safety = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
  const migration = read('prisma/migrations/20260903010000_virtual_account_terminal_deletion/migration.sql');

  it('keeps system accounts out of generic deletion and leaves their owning domains authoritative', () => {
    expect(deletion).toContain("account.kind !== 'CUSTOM'");
    expect(deletion).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(safety).toContain('requireCustomControlAccount');
    expect(terminal).toContain("account.kind !== 'CUSTOM'");
    expect(deletion).not.toContain('hideDomainOwnedAccount');
  });

  it('zeroes non-empty CUSTOM pockets atomically with audit entries and frees deleted treasury identity', () => {
    expect(deletion).toContain('CONTROL_DELETE_RESET');
    expect(deletion).toContain('args.account.balance > 0n');
    expect(deletion).toContain('args.finance.bankBalance > 0n');
    expect(deletion).toContain('SET "bankBalance"=0');
    expect(deletion).toContain('SET "balance"=0');
    expect(deletion).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(deletion).toContain('const mustPreserveRow = hasMoney');
  });

  it('never destroys lottery, market, order or ledger history to make a CUSTOM account disappear', () => {
    expect(deletion).toContain('"LotteryRound"');
    expect(deletion).toContain('"EconomyMarketListing"');
    expect(deletion).toContain('"EconomyMarketPurchase"');
    expect(deletion).toContain('"EconomyMarketOrder"');
    expect(deletion).toContain('"EconomyVirtualAccountDeleted"');
    expect(deletion).not.toContain('DELETE FROM "LotteryRound"');
    expect(deletion).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  it('migrates old control-hidden markers into a scoped terminal deleted marker and drops system markers', () => {
    expect(migration).toContain('DELETE FROM "EconomyVirtualAccountControlHidden" marker');
    expect(migration).toContain("account.\"kind\" <> 'CUSTOM'::\"EconomyVirtualAccountKind\"");
    expect(migration).toContain('RENAME TO "EconomyVirtualAccountDeleted"');
    expect(migration).toContain('RENAME COLUMN "hiddenAt" TO "deletedAt"');
    expect(migration).toContain('FOREIGN KEY ("accountId", "guildId", "nitradoConnId")');
    expect(migration).toContain('REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
  });

  it('never lists terminally deleted CUSTOM accounts and permanently rejects restore', () => {
    expect(terminal).toContain('listDeletedVirtualAccountIds');
    expect(terminal).toContain("account.kind === 'CUSTOM' && !deletedIds.has(account.id)");
    expect(terminal).toContain("post('/control/accounts/:accountId/restore'");
    expect(terminal).toContain("res.status(410)");
    expect(terminal).toContain('Gelöschte Konten können nicht wiederhergestellt werden.');
    expect(deletion).toContain('return false;');
    expect(deletion).not.toContain('DELETE FROM "EconomyVirtualAccountDeleted" WHERE "accountId"');
  });

  it('runs terminal deletion before the Phase-2 capability and compatibility routers', () => {
    expect(v2.indexOf('economyVirtualAccountTerminalDeletionRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'));
    expect(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountControlRouter'));
  });
});