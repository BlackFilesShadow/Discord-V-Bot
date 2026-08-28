import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete balance gate', () => {
  it('requires both wallet and bank balances to be zero under row locks', () => {
    expect(source).toContain('LIMIT 1 FOR UPDATE');
    expect(source).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).toContain('Loeschen ist nur bei Wallet=0 und Bank=0 moeglich.');
  });
});
