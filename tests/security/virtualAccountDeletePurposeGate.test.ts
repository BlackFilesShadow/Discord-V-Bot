import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete purpose gate', () => {
  it('allows terminal generic deletion only for empty CUSTOM accounts', () => {
    expect(source).toContain("if (account.kind !== 'CUSTOM')");
    expect(source).toContain('Systemkonten werden ausschließlich über ihre Fachfunktion verwaltet.');
    expect(source).toContain("finance.accountPurpose === 'BANK_TREASURY'");
    expect(source).toContain('Konto wird noch von einem aktiven Fachvorgang verwendet und kann nicht generisch gelöscht werden.');
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind"`);
  });

  it('never frees a system-account purpose through the generic delete path', () => {
    expect(source).not.toContain("finance.accountPurpose = 'GENERAL'");
    expect(source).not.toContain("accountPurpose: 'GENERAL'");
    expect(source).not.toContain('CONTROL_DELETE_RESET');
  });
});
