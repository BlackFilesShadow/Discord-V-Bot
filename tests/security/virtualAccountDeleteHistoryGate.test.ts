import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(repoRoot, 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
const migration = fs.readFileSync(
  path.join(repoRoot, 'prisma/migrations/20260903010000_virtual_account_terminal_deletion/migration.sql'),
  'utf8',
);

describe('virtual account hard-delete history gate', () => {
  it('snapshots terminal identity before deleting only the live account row', () => {
    const identitySnapshot = source.indexOf('UPDATE "EconomyVirtualAccountHistoryIdentity" SET "deletedAt"=CURRENT_TIMESTAMP');
    const deletion = source.indexOf('DELETE FROM "EconomyVirtualAccount"');

    expect(identitySnapshot).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(identitySnapshot);
    expect(source).not.toContain('DELETE FROM "EconomyVirtualAccountEntry"');
    expect(source).not.toContain('DELETE FROM "LotteryRound"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketListing"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(source).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  it('moves immutable history to a scoped RESTRICT identity rather than requiring a live tombstone', () => {
    const historicalRelations = [
      ['EconomyVirtualAccountEntry', 'virtualAccountId', 'EconomyVirtualAccountEntry_history_identity_fkey'],
      ['LotteryRound', 'potAccountId', 'LotteryRound_pot_history_identity_fkey'],
      ['EconomyMarketListing', 'vendorAccountId', 'EconomyMarketListing_vendor_history_identity_fkey'],
      ['EconomyMarketPurchase', 'vendorAccountId', 'EconomyMarketPurchase_vendor_history_identity_fkey'],
      ['EconomyMarketOrder', 'vendorAccountId', 'EconomyMarketOrder_vendor_history_identity_fkey'],
    ] as const;

    expect(migration).toContain('"EconomyVirtualAccountHistoryIdentity_scope_key"');
    for (const [table, accountColumn, constraint] of historicalRelations) {
      const relation = new RegExp(
        `ALTER TABLE "${table}"[\\s\\S]*?ADD CONSTRAINT "${constraint}"[\\s\\S]*?FOREIGN KEY \\("${accountColumn}", "guildId", "nitradoConnId"\\)[\\s\\S]*?REFERENCES "EconomyVirtualAccountHistoryIdentity"\\("accountId", "guildId", "nitradoConnId"\\)[\\s\\S]*?ON DELETE RESTRICT`,
        'm',
      );
      expect(migration).toMatch(relation);
    }
  });

  it('keeps new economic writes fail-closed after terminal deletion', () => {
    expect(migration).toContain('new virtual-account ledger entry requires a live account');
    expect(migration).toContain('active lottery round requires a live pot account');
    expect(migration).toContain('active market listing requires a live vendor account');
    expect(migration).toContain('new market purchase requires a live vendor account');
    expect(migration).toContain('open market order requires a live vendor account');
  });
});
