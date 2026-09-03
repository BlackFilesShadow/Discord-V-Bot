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

  it('fails closed on non-empty CUSTOM pockets and never rewrites balances during delete', () => {
    expect(deletion).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(deletion).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
    expect(deletion).not.toContain('CONTROL_DELETE_RESET');
    expect(deletion).not.toContain('SET "bankBalance"=0');
    expect(deletion).not.toContain('SET "balance"=0');
    expect(deletion).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(deletion).toContain("mode: 'HARD_DELETED'");
  });

  it('preserves immutable history through a dedicated scoped identity, not a retained live row', () => {
    expect(migration).toContain('CREATE TABLE "EconomyVirtualAccountHistoryIdentity"');
    expect(migration).toContain('EconomyVirtualAccountEntry_history_identity_fkey');
    expect(migration).toContain('LotteryRound_pot_history_identity_fkey');
    expect(migration).toContain('EconomyMarketListing_vendor_history_identity_fkey');
    expect(migration).toContain('EconomyMarketPurchase_vendor_history_identity_fkey');
    expect(migration).toContain('EconomyMarketOrder_vendor_history_identity_fkey');
    expect(deletion).not.toContain("mode: 'HISTORY_RETAINED'");
    expect(deletion).not.toContain('EconomyVirtualAccountDeleted');
    expect(deletion).not.toContain('DELETE FROM "LotteryRound"');
    expect(deletion).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  it('migrates old CUSTOM hidden state fail-closed and removes CONTROL_HIDDEN storage', () => {
    expect(migration).toContain('terminal deletion migration blocked: hidden CUSTOM account has funds or missing finance');
    expect(migration).toContain('terminal deletion migration blocked: hidden CUSTOM account still owns active domain work');
    expect(migration).toContain('UPDATE "EconomyVirtualAccountHistoryIdentity" history');
    expect(migration).toContain('DELETE FROM "EconomyVirtualAccount" account');
    expect(migration).toContain('DROP TABLE "EconomyVirtualAccountControlHidden"');
    expect(migration).not.toContain('RENAME TO "EconomyVirtualAccountDeleted"');
  });

  it('serializes new economic writes and active domain work against terminal live deletion', () => {
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('EconomyVirtualAccountEntry_require_live_account');
    expect(migration).toContain('LotteryRound_require_live_pot');
    expect(migration).toContain('EconomyMarketListing_require_live_vendor');
    expect(migration).toContain('EconomyMarketPurchase_require_live_vendor');
    expect(migration).toContain('EconomyMarketOrder_require_live_vendor');
    expect(migration).toContain('new virtual-account ledger entry requires a live account');
    expect(migration).toContain('new market purchase requires a live vendor account');
    expect(deletion).toContain('FOR UPDATE');
    expect(deletion).toContain('aktiven Fachvorgang');
  });

  it('never lists terminally deleted CUSTOM accounts and permanently rejects restore', () => {
    expect(terminal).toContain('listDeletedVirtualAccountIds');
    expect(terminal).toContain("account.kind === 'CUSTOM' && !deletedIds.has(account.id)");
    expect(terminal).toContain("post('/control/accounts/:accountId/restore'");
    expect(terminal).toContain('res.status(410)');
    expect(terminal).toContain('Gelöschte Konten können nicht wiederhergestellt werden.');
    expect(deletion).toContain('return false;');
  });

  it('blocks direct mutations against terminally deleted account IDs', () => {
    expect(terminal).toContain('async function rejectDeletedMutation');
    expect(terminal).toContain('Dieses Konto wurde dauerhaft gelöscht und kann nicht mehr verändert werden.');
    expect(terminal).toContain("put('/control/accounts/:accountId'");
    expect(terminal).toContain("delete('/control/accounts/:accountId'");
    expect(terminal).toContain("post('/control/accounts/:accountId/sync'");
    expect(terminal).toContain("post('/:accountId/archive'");
    expect(terminal).toContain("post('/:accountId/payout'");
  });

  it('runs terminal deletion before the Phase-2 capability and compatibility routers', () => {
    expect(v2.indexOf('economyVirtualAccountTerminalDeletionRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'));
    expect(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'))
      .toBeLessThan(v2.indexOf('economyVirtualAccountControlRouter'));
  });
});