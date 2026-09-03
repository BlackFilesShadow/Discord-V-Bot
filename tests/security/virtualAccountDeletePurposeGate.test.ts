import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete purpose gate', () => {
  it('allows terminal generic deletion only for empty CUSTOM accounts', () => {
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(source).toContain('account.balance !== 0n || finance.bankBalance !== 0n');
    expect(source).toContain('Konto kann mit Restguthaben nicht gelöscht werden. Wallet und Bank müssen zuerst 0 sein.');
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
  });

  it('never frees a system-account purpose through the generic delete path', () => {
    expect(source).not.toContain("finance.accountPurpose = 'GENERAL'");
    expect(source).not.toContain("accountPurpose: 'GENERAL'");
    expect(source).not.toContain('CONTROL_DELETE_RESET');
  });
});
