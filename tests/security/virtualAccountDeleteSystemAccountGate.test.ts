import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account system hard-delete gate', () => {
  it('keeps physical delete restricted to CUSTOM while domain-owned accounts are control-hidden', () => {
    expect(source).toContain("account.kind === 'LOTTERY_POT' || account.kind === 'MARKET_VENDOR'");
    expect(source).toContain('return hideDomainOwnedAccount');
    expect(source).toContain('domainPreserved: true');
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
    expect(source).not.toContain('DELETE FROM "LotteryRound"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketPurchase"');
  });

  it('allows server-bank removal while preserving non-empty CUSTOM history and freeing treasury identity', () => {
    expect(source).toContain('CONTROL_DELETE_RESET');
    expect(source).toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(source).toContain('writeControlHidden');
    expect(source).toContain("mode: 'CONTROL_HIDDEN'");
    expect(source).not.toContain('Die Serverbank ist ein geschuetztes Systemkonto und kann nicht geloescht werden.');
  });
});
