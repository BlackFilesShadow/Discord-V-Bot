import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete balance reset gate', () => {
  it('locks wallet and bank rows, resets both balances, then hard-deletes', () => {
    expect(source).toContain('LIMIT 1 FOR UPDATE');
    expect(source).toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toContain('DELETE FROM "EconomyVirtualAccount"');

    const financeReset = source.indexOf('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    const walletReset = source.indexOf('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    const deletion = source.indexOf('DELETE FROM "EconomyVirtualAccount"');
    expect(financeReset).toBeGreaterThan(-1);
    expect(walletReset).toBeGreaterThan(financeReset);
    expect(deletion).toBeGreaterThan(walletReset);
  });
});