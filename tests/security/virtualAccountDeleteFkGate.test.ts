import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260816124500_economy_virtual_accounts/migration.sql'), 'utf8');

describe('virtual account delete FK gate', () => {
  it('keeps RESTRICT history foreign keys and translates FK races into a safe failure', () => {
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(source).toContain("candidate.code === '23503'");
    expect(source).toContain('Das Konto wurde während der Löschung neu von geschützter Historie referenziert.');
    expect(source).toContain('Es wurde nicht teilweise gelöscht;');
  });
});
