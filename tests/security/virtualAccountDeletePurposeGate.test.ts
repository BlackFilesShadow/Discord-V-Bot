import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete purpose gate', () => {
  it('does not block BANK_TREASURY removal and safely frees the treasury identity when history is preserved', () => {
    expect(source).not.toContain("finance.accountPurpose !== 'GENERAL'");
    expect(source).toMatch(/accountPurpose[^\n]*BANK_TREASURY[^\n]*GENERAL/);
    expect(source).toContain(String.raw`AND "kind"=\'CUSTOM\'::"EconomyVirtualAccountKind" AND "balance"=0`);
  });
});
