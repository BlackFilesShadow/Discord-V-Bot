import fs from 'node:fs';
import path from 'node:path';

test('virtual account deletion resets wallet and bank before hide/delete', () => {
  const deletion = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
  expect(deletion).toContain('SET "bankBalance"=0');
  expect(deletion).toContain('SET "balance"=0');
  expect(deletion).toContain('EconomyVirtualAccountControlHidden');
});
