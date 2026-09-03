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

  it('never burns wallet or bank funds and only declassifies an already-empty deleted treasury', () => {
    expect(source).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
    expect(source).not.toContain('CONTROL_DELETE_RESET');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(source).toContain('writeDeletedMarker');
    expect(source).toContain("mode: 'HISTORY_RETAINED'");
    expect(source).not.toContain("mode: 'CONTROL_HIDDEN'");
  });
});