import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete balance gate', () => {
  it('locks wallet and bank rows and fails closed while either pocket still has funds', () => {
    expect(source).toContain('LIMIT 1 FOR UPDATE');
    expect(source).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
  });
});