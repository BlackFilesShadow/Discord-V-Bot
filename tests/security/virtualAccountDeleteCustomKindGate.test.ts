import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');

describe('virtual account delete kind gate', () => {
  it('allows physical removal only for CUSTOM accounts', () => {
    expect(source).toContain("account.kind !== 'CUSTOM'");
  });
});
