import fs from 'node:fs';
import path from 'node:path';

test('virtual account deletion never burns funds and removes the live row terminally', () => {
  const deletion = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
  expect(deletion).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
  expect(deletion).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
  expect(deletion).not.toContain('SET "bankBalance"=0');
  expect(deletion).not.toContain('SET "balance"=0');
  expect(deletion).not.toContain('CONTROL_DELETE_RESET');
  expect(deletion).toContain('EconomyVirtualAccountHistoryIdentity');
  expect(deletion).toContain('DELETE FROM "EconomyVirtualAccount"');
  expect(deletion).toContain("mode: 'HARD_DELETED'");
  expect(deletion).not.toContain("mode: 'HISTORY_RETAINED'");
  expect(deletion).not.toContain('EconomyVirtualAccountDeleted');
});