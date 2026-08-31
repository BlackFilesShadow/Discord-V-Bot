import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('market control removal and limit-free contract', () => {
  test('migration preserves listing rows while adding scoped control tombstones and removing business quantity cap', () => {
    const migration = read('prisma/migrations/20260831220000_economy_control_cleanup/migration.sql');
    expect(migration).toContain('CREATE TABLE "EconomyMarketListingControlHidden"');
    expect(migration).toContain('FOREIGN KEY ("listingId", "guildId", "nitradoConnId")');
    expect(migration).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(migration).toContain('DROP CONSTRAINT IF EXISTS "EconomyMarketPurchase_quantity_positive_check"');
    expect(migration).toContain('CHECK ("quantity" >= 1)');
    expect(migration).not.toContain('"quantity" <= 1000');
  });

  test('removal archives and hides an offer instead of deleting purchases/listing history', () => {
    const deletion = read('src/modules/economy/blackMarketControlDeletion.ts');
    const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
    expect(deletion).toContain('SET "active"=FALSE');
    expect(deletion).toContain('EconomyMarketListingControlHidden');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketListing"');
    expect(deletion).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(route).toContain("delete('/listings/:listingId'");
    expect(route).toContain('removeMarketListingFromControl');
    expect(route).toContain('MARKET_LISTING_REMOVED');
  });

  test('production refund does not restore a legacy stock value', () => {
    const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
    const refund = read('src/modules/economy/blackMarketInventorylessRefund.ts');
    expect(route).toContain('refundInventorylessMarketPurchase');
    expect(refund).not.toContain('"stock"="stock"+');
    expect(refund).toContain("'REFUNDED'");
  });
});
