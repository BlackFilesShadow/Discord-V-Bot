import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account system hard-delete gate', () => {
  it('keeps physical delete restricted to CUSTOM while preserving market and bank protections', () => {
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain("if (account.kind !== 'LOTTERY_POT')");
    expect(source).toContain('Schwarzmarkt-Systemkonten koennen nicht geloescht werden.');
    expect(source).toContain("finance.accountPurpose !== 'GENERAL'");
    expect(source).toContain('Die Serverbank ist ein geschuetztes Systemkonto und kann nicht geloescht werden.');
    expect(source).toContain(String.raw`AND \"kind\"=\'CUSTOM\'::\"EconomyVirtualAccountKind\"`);
  });

  it('allows only archived zero-balance lottery pots to be hidden from control without deleting history', () => {
    expect(source).toContain("account.kind !== 'LOTTERY_POT'");
    expect(source).toContain("account.status !== 'ARCHIVED'");
    expect(source).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).toContain('"status" NOT IN (\'FINISHED\'::"LotteryRoundStatus", \'REFUNDED\'::"LotteryRoundStatus")');
    expect(source).toContain('"EconomyVirtualAccountControlHidden"');
    expect(source).toContain("mode: 'CONTROL_HIDDEN'");
    expect(source).not.toContain('DELETE FROM "LotteryRound"');
    expect(source).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
  });
});
