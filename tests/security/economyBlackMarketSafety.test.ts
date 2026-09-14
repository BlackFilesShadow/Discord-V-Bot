import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Economy-Schwarzmarkt — Production-Sicherheitsinvarianten', () => {
  const market = read('src/modules/economy/blackMarket.ts');
  const inventoryless = read('src/modules/economy/blackMarketInventoryless.ts');
  const migration = read('prisma/migrations/20260816143000_economy_black_market/migration.sql');
  const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
  const apiClient = read('dashboard-ui/src/lib/api.ts');
  const schema = read('prisma/schema.prisma');

  it('ist strikt Guild+Gameserver-gescoppt und nutzt MARKET_VENDOR statt Nebenwaehrung', () => {
    expect(market).toContain('guildId: GuildId');
    expect(market).toContain('nitradoConnId: NitradoConnId');
    expect(market).toContain("expectedKind: 'MARKET_VENDOR'");
    expect(market).toContain('systemVirtualAccountToUser');
    expect(inventoryless).toContain('systemUserToVirtualAccount');
    expect(schema).toContain('MARKET_VENDOR');
  });

  it('serialisiert parallele Kaeufe per Listing-Rowlock und verwirft veraltete Preis-/Haendlerdaten', () => {
    // Bestandsfreies (inventoryless) Kaufmodell: Angebote sind durch active/archivedAt
    // begrenzt, nicht durch Stock. Der Rowlock schuetzt weiterhin gegen ein Listing,
    // das waehrend des Kaufs (Preis/Haendler) veraendert wurde.
    expect(inventoryless).toContain('FROM "EconomyMarketListing" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE');
    expect(inventoryless).toContain('if (!listing || !listing.active || listing.archivedAt)');
    expect(inventoryless).toContain('Listing wurde waehrend des Kaufs geaendert. Bitte erneut versuchen.');
  });

  it('bindet Geld und Purchase-Audit in dieselbe atomare Systemtransfer-Transaktion', () => {
    const transferStart = inventoryless.indexOf('const transfer = await systemUserToVirtualAccount');
    const mutateStart = inventoryless.indexOf('mutate: async', transferStart);
    const purchaseInsert = inventoryless.indexOf('INSERT INTO "EconomyMarketPurchase"', mutateStart);
    const fulfillmentInsert = inventoryless.indexOf('INSERT INTO "EconomyMarketPurchaseFulfillment"', mutateStart);
    expect(transferStart).toBeGreaterThan(-1);
    expect(mutateStart).toBeGreaterThan(transferStart);
    expect(purchaseInsert).toBeGreaterThan(mutateStart);
    expect(fulfillmentInsert).toBeGreaterThan(purchaseInsert);
  });

  it('wehrt Idempotency-Payload-Mismatch ab und archiviert statt Kaufhistorie zu loeschen', () => {
    expect(inventoryless).toContain('Market-Idempotency-Key wurde mit anderen Kaufdaten wiederverwendet.');
    expect(market).toContain('archivedAt: new Date()');
    expect(migration).toContain('EconomyMarketListing_vendor_scope_fkey');
    expect(migration).toContain('EconomyMarketPurchase_listing_scope_fkey');
    expect(migration).toContain('ON DELETE RESTRICT');
    expect(migration).not.toContain('ON DELETE CASCADE');
  });

  it('akzeptiert den retry-stabilen Dashboard-UUID-Key ohne die Domain-Grenze zu erweitern', () => {
    expect(apiClient).toContain("crypto.randomUUID()");
    expect(apiClient).toContain("headers['X-Idempotency-Key'] = lease.key");
    expect(route).toContain('const candidate = raw ? `${prefix}:${raw}` : null;');
    expect(route).toContain('candidate.length > 48');
    expect(route).not.toContain('raw.length > 32');
    expect(inventoryless).toContain('normalized.length > 48');
    expect(inventoryless).not.toContain('normalized.length > 32');
    expect(route).toContain("idempotencyKey: operationKey(req, 'dashboard')");
  });

  it('erzwingt fachliche DB-Grenzen fuer Preis, Menge und Betrag', () => {
    expect(migration).toContain('CHECK ("price" > 0)');
    expect(migration).toContain('CHECK ("quantity" >= 1 AND "quantity" <= 1000)');
    expect(migration).toContain('CHECK ("amount" = "unitPrice" * "quantity")');
    expect(migration).toContain('CREATE UNIQUE INDEX "EconomyMarketPurchase_idempotency_key"');
    expect(migration).toContain('EconomyMarketPurchase_source_pocket_check');
  });

  it('schuetzt Verwaltung mit economy.manage und Kauf/Lesen mit Economy-Scope', () => {
    expect(route).toContain("requireGuildPermission('economy.manage')");
    expect(route).toContain("requireGuildPermission('economy.view')");
    expect(route).toContain('scope.nitradoConnId');
  });
});
