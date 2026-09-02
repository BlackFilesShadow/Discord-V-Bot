import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account system hard-delete gate', () => {
  it('rejects all system accounts and keeps physical delete restricted to CUSTOM', () => {
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
    expect(source).not.toContain('hideDomainOwnedAccount');
    expect(source).not.toContain('DELETE FROM "LotteryRound"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  it('allows server-bank terminal removal while retaining history and freeing treasury identity', () => {
    expect(source).toContain('CONTROL_DELETE_RESET');
    expect(source).toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(source).toContain('writeDeletedMarker');
    expect(source).toContain("mode: 'HISTORY_RETAINED'");
    expect(source).not.toContain("mode: 'CONTROL_HIDDEN'");
  });
});