import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account system hard-delete gate', () => {
  it('protects lottery, market and bank treasury accounts', () => {
    expect(source).toContain("account.kind !== 'CUSTOM'");
    expect(source).toContain("finance.accountPurpose !== 'GENERAL'");
    expect(source).toContain('Systemkonten von Lotterie oder Schwarzmarkt koennen nicht geloescht werden.');
    expect(source).toContain('Die Serverbank ist ein geschuetztes Systemkonto und kann nicht geloescht werden.');
  });
});
