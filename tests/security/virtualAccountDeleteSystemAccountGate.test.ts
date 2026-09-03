import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
const normalizedSource = source.replaceAll('\\', '');

describe('virtual account system hard-delete gate', () => {
  // Serverbank is CUSTOM-backed, so its BANK_TREASURY finance purpose is part of the hard-delete boundary.
  it('rejects all domain-owned accounts and keeps physical delete restricted to generic CUSTOM', () => {
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(source).toContain("finance.accountPurpose === 'BANK_TREASURY'");
    expect(source).toContain('Serverbank-Konten werden ausschließlich über die Serverbank-Funktion verwaltet und können nicht generisch gelöscht werden.');
    expect(normalizedSource).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(normalizedSource).toContain('AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"');
    expect(normalizedSource).not.toContain('AND "balance"=0');
    expect(source).not.toContain('hideDomainOwnedAccount');
    expect(source).not.toContain('DELETE FROM "LotteryRound"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  it('removes balances only with the successful selected generic CUSTOM delete from live storage', () => {
    expect(source).not.toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).not.toContain('CONTROL_DELETE_RESET');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"=0');
    expect(source).not.toContain('UPDATE "EconomyVirtualAccount" SET "balance"=0');
    expect(source).not.toContain('writeDeletedMarker');
    expect(source).toContain('EconomyVirtualAccountHistoryIdentity');
    expect(source).toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(source).toContain('walletRemoved: account.balance.toString()');
    expect(source).toContain('bankRemoved: finance.bankBalance.toString()');
    expect(source).toContain("mode: 'HARD_DELETED'");
    expect(source).not.toContain("mode: 'HISTORY_RETAINED'");
  });
});