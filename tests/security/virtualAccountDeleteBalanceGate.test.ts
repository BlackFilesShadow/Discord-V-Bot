import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete balance gate', () => {
  it('locks wallet and bank rows and removes their balances with the selected CUSTOM account', () => {
    expect(source).toContain('LIMIT 1 FOR UPDATE');
    expect(source).not.toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"`);
    expect(source).toContain('walletRemoved: account.balance.toString()');
    expect(source).toContain('bankRemoved: finance.bankBalance.toString()');
  });
});