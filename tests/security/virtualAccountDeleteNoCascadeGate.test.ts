import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma/migrations/20260816124500_economy_virtual_accounts/migration.sql'), 'utf8');

describe('virtual account ledger delete protection', () => {
  it('does not cascade virtual account ledger entries', () => {
    const fk = migration.match(/ALTER TABLE "EconomyVirtualAccountEntry"[\s\S]*?;/g)?.join('\n') ?? migration;
    expect(fk).toContain('ON DELETE RESTRICT');
  });
});
