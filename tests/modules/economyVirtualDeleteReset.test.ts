import fs from 'node:fs';
import path from 'node:path';

test('virtual account deletion never burns funds before terminal history retention', () => {
  const deletion = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
  expect(deletion).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
  expect(deletion).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
  expect(deletion).not.toContain('SET "bankBalance"=0');
  expect(deletion).not.toContain('SET "balance"=0');
  expect(deletion).toContain('EconomyVirtualAccountDeleted');
  expect(deletion).toContain("mode: 'HISTORY_RETAINED'");
  expect(deletion).not.toContain("mode: 'CONTROL_HIDDEN'");
});