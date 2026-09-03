import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'src/modules/economy/virtualAccountDeletion.ts'), 'utf8');
const migration = fs.readFileSync(path.join(ROOT, 'prisma/migrations/20260903010000_virtual_account_terminal_deletion/migration.sql'), 'utf8');
const identityModel = fs.readFileSync(path.join(ROOT, 'prisma/economy_virtual_account_history_identity.prisma'), 'utf8');

describe('virtual account delete FK gate', () => {
  it('moves immutable history FKs to the scoped identity and keeps them RESTRICT', () => {
    expect(identityModel).toContain('model EconomyVirtualAccountHistoryIdentity');
    expect(identityModel).toContain('@@unique([accountId, guildId, nitradoConnId]');
    expect(identityModel).toContain('@@index([guildId, nitradoConnId, deletedAt]');
    expect(migration).toContain('CREATE TABLE "EconomyVirtualAccountHistoryIdentity"');
    for (const constraint of [
      'EconomyVirtualAccountEntry_history_identity_fkey',
      'LotteryRound_pot_history_identity_fkey',
      'EconomyMarketListing_vendor_history_identity_fkey',
      'EconomyMarketPurchase_vendor_history_identity_fkey',
      'EconomyMarketOrder_vendor_history_identity_fkey',
    ]) expect(migration).toContain(constraint);
    expect(migration).toContain('REFERENCES "EconomyVirtualAccountHistoryIdentity"("accountId", "guildId", "nitradoConnId")');
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
  });

  it('serializes all new economic writes and active domain work against live deletion', () => {
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain('EconomyVirtualAccountEntry_require_live_account');
    expect(migration).toContain('LotteryRound_require_live_pot');
    expect(migration).toContain('EconomyMarketListing_require_live_vendor');
    expect(migration).toContain('EconomyMarketPurchase_require_live_vendor');
    expect(migration).toContain('EconomyMarketOrder_require_live_vendor');
    expect(source).toContain('FOR UPDATE');
    expect(source).toContain("candidate.code === '23503'");
    expect(source).toContain('geschütztem Live-Zustand referenziert');
    expect(source).toContain('Es wurde nicht teilweise gelöscht.');
  });
});