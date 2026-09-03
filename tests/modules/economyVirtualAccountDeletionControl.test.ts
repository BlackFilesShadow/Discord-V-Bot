import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('custom account deletion is terminal while immutable history stays referentially valid', () => {
  const deletion = read('src/modules/economy/virtualAccountDeletion.ts');
  const route = read('src/dashboard/routes/v2/economyVirtualAccountControl.ts');
  const terminal = read('src/dashboard/routes/v2/economyVirtualAccountTerminalDeletion.ts');
  const migration = read('prisma/migrations/20260903010000_virtual_account_terminal_deletion/migration.sql');
  const v2 = read('src/dashboard/routes/v2.ts');
  const ui = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');

  expect(deletion).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
  expect(deletion).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
  expect(deletion).not.toContain('SET "bankBalance"=0');
  expect(deletion).not.toContain('SET "balance"=0');
  expect(deletion).not.toContain('CONTROL_DELETE_RESET');
  expect(deletion).toContain('EconomyVirtualAccountHistoryIdentity');
  expect(deletion).toContain("mode: 'HARD_DELETED'");
  expect(deletion).not.toContain("mode: 'HISTORY_RETAINED'");
  expect(deletion).not.toContain('EconomyVirtualAccountDeleted');
  expect(deletion).toContain("account.kind !== 'CUSTOM'");
  expect(deletion).toContain('DELETE FROM "EconomyVirtualAccount"');

  expect(migration).toContain('CREATE TABLE "EconomyVirtualAccountHistoryIdentity"');
  expect(migration).toContain('EconomyVirtualAccountEntry_history_identity_fkey');
  expect(migration).toContain('LotteryRound_pot_history_identity_fkey');
  expect(migration).toContain('EconomyMarketListing_vendor_history_identity_fkey');
  expect(migration).toContain('EconomyMarketPurchase_vendor_history_identity_fkey');
  expect(migration).toContain('EconomyMarketOrder_vendor_history_identity_fkey');
  expect(migration).toContain('DROP TABLE "EconomyVirtualAccountControlHidden"');

  expect(terminal).toContain('!deletedIds.has(account.id)');
  expect(terminal).toContain('Gelöschte Konten können nicht wiederhergestellt werden.');
  expect(v2.indexOf('economyVirtualAccountTerminalDeletionRouter'))
    .toBeLessThan(v2.indexOf('economyVirtualAccountTreasurySafetyRouter'));
  expect(ui).toContain("{deleteArmed ? 'Wirklich löschen?' : 'Löschen'}");
  expect(route.indexOf('deleteUnusedVirtualAccount')).toBeLessThan(route.indexOf('retireVirtualAccountProjection', route.indexOf("delete('/control/accounts/:accountId'")));
});

test('virtual account live updates are serialized per account, not per channel', () => {
  const live = read('src/modules/economy/virtualAccountLiveUpdates.ts');
  const discord = read('src/modules/economy/virtualAccountDiscord.ts');
  const migration = read('prisma/migrations/20260826190000_virtual_account_wallet_bank_currency_projection/migration.sql');

  expect(live).toContain('accountSyncInFlight');
  expect(live).toContain('${String(guildId)}:${String(connId)}:${accountId}');
  expect(discord).toContain('archiveChannel.threads.create');
  expect(discord).toContain('archiveThreadId');
  expect(migration).toContain('EconomyVirtualAccountProjection_pkey');
  expect(migration).not.toContain('UNIQUE ("channelId")');
});