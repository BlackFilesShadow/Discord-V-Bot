import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy-Schwarzmarkt — Fulfillment- und Vendor-Lifecycle-Gate', () => {
  const market = read('src/modules/economy/blackMarket.ts');
  const transfers = read('src/modules/economy/systemVirtualTransfers.ts');
  const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
  const command = read('src/commands/dashboard/blackMarket.ts');
  const migration = read('prisma/migrations/20260826212000_economy_black_market_fulfillment/migration.sql');
  const completionMigration = read('prisma/migrations/20260828124500_economy_lottery_market_interest_completion/migration.sql');

  it('persistiert freien Itemtext ohne DayZ-Katalog und bewahrt unveraenderliche Kauf-Snapshots', () => {
    expect(market).toContain('normalizeMarketItemText');
    expect(market).toContain('row.itemText ?? row.className');
    expect(market).not.toContain('getDayz129Index');
    expect(market).not.toContain('Unbekannter DayZ-1.29-Classname');
    expect(completionMigration).toContain('fachlich Freitext statt DayZ-Classname');
    expect(migration).toContain('CREATE TABLE "EconomyMarketListingItem"');
    expect(migration).toContain('CREATE TABLE "EconomyMarketPurchaseFulfillment"');
    expect(migration).toContain('EconomyMarketPurchase_id_scope_key');
    expect(market).toContain('deliverySnapshot');
    expect(market).toContain('itemText: item.itemText');
    expect(market).toContain("'PENDING'");
  });

  it('erstellt bei einfachen Angeboten automatisch den Item-Snapshot und multipliziert ihn mit der Kaufmenge', () => {
    expect(market).toContain("[{ itemText: name, quantity: 1 }]");
    expect(market).toContain("[{ itemText: listing.name, quantity: 1 }]");
    expect(market).toContain('quantity: item.quantity * args.quantity');
    expect(market).not.toContain('noch kein DayZ-Liefer-Bundle');
  });

  it('macht Refund atomar mit Vendor-Abbuchung, User-Gutschrift, Status und Bestandsrueckgabe', () => {
    const refund = market.slice(market.indexOf('export async function refundMarketPurchase'));
    expect(refund).toContain('systemVirtualAccountToUser');
    expect(refund).toContain('beforeLock: async raw =>');
    expect(refund).toContain('FOR UPDATE');
    expect(refund).toContain('"stock"="stock"+$4');
    expect(refund).toContain('REFUNDED');
    expect(refund).toContain('targetPocket: before.sourcePocket');
    expect(transfers).toContain('beforeLock?:');
    expect(transfers).toContain('beforeDebit?:');
  });

  it('reserviert offene Bestellbetraege gegen Vendor-Auszahlungen', () => {
    const payout = market.slice(market.indexOf('export async function payoutMarketVendor'), market.indexOf('export async function archiveMarketVendor'));
    expect(payout).toContain('PENDING');
    expect(payout).toContain('liability');
    expect(payout).toContain('withdrawable');
    expect(payout).toContain("expectedKind: 'MARKET_VENDOR'");
  });

  it('archiviert Vendoren erst ohne aktive Listings, offene Bestellungen und Guthaben', () => {
    const archive = market.slice(market.indexOf('export async function archiveMarketVendor'));
    expect(archive).toContain('Haendler hat noch aktive Angebote');
    expect(archive).toContain('Haendler hat noch offene Bestellungen');
    expect(archive).toContain('Haendler besitzt noch Guthaben');
  });

  it('exponiert Manager-Fulfillment und Buyer-Order-Status in API und Discord', () => {
    expect(route).toContain("put('/listings/:listingId/items'");
    expect(route).toContain("post('/purchases/:purchaseId/deliver'");
    expect(route).toContain("post('/purchases/:purchaseId/refund'");
    expect(route).toContain("post('/vendors/:vendorId/payout'");
    expect(route).toContain("post('/vendors/:vendorId/archive'");
    expect(command).toContain("setName('orders')");
    expect(command).toContain("setName('quelle')");
    expect(command).toContain('listMarketPurchasesForUser');
    expect(command).toContain('item.itemText');
  });

  it('markiert Altkaeufe explizit als LEGACY statt sie erneut auszuliefern', () => {
    expect(migration).toContain("'LEGACY'");
    expect(migration).toContain("CHECK (\"status\" IN ('PENDING','DELIVERED','REFUNDED','LEGACY'))");
  });
});