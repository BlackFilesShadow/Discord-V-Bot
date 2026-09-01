import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('market vendor catalogs are fixed per vendor, paged and serialized', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const prismaModel = read('prisma/economy_market_projection.prisma');
  const interactions = read('src/modules/economy/blackMarketInteractions.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  expect(projection).toContain('CATALOG_ITEMS_PER_MESSAGE = 5');
  expect(projection).toContain('economyMarketVendorCatalogProjection');
  expect(prismaModel).toContain('model EconomyMarketVendorCatalogProjection');
  expect(prismaModel).toContain('@@unique([projectionId, vendorAccountId]');
  expect(projection).toContain('marketcat:v1:page:${catalogProjectionId}');
  expect(projection).toContain('marketorder:open:v1:${catalogProjectionId}');
  expect(projection).toContain('const syncInFlight = new Map');
  expect(projection).toContain('previous.catch(() => null).then(() => syncUnsafe');
  expect(composite).toContain("i.customId.startsWith('marketcat:v1:')");
  expect(composite).toContain('handleMarketVendorCatalogPageButton');

  // Direct Buy bleibt bewusst auf dem bestehenden, listing-gebundenen Vertrag.
  expect(projection).toContain("kind: 'DIRECT_BUY'");
  expect(projection).toContain('listingId: listing.id');
  expect(interactions).toContain('buyInventorylessMarketListing');
  expect(interactions).toContain('syncMarketDiscordProjection');
  expect(composite).toContain("i.customId.startsWith('marketbuy:')");
  expect(composite).toContain("i.customId.startsWith('marketbuy_modal:')");
});

test('vendor loading is batched and 300 listings remain safely navigable', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const vendorLoaderStart = projection.indexOf('async function loadActiveVendorCatalogs');
  const vendorLoaderEnd = projection.indexOf('async function upsertVendorCatalogMessages');
  const vendorLoader = projection.slice(vendorLoaderStart, vendorLoaderEnd);

  expect(vendorLoaderStart).toBeGreaterThan(-1);
  expect(vendorLoader).toContain('economyVirtualAccount.findMany');
  expect(vendorLoader).toContain("kind: 'MARKET_VENDOR'");
  expect(vendorLoader).toContain("status: 'ACTIVE'");
  expect(vendorLoader).not.toContain('getVirtualAccountById');
  expect(Math.ceil(300 / 5)).toBe(60);
  expect(projection).toContain('const pages = chunk(catalog.listings, CATALOG_ITEMS_PER_MESSAGE)');
  expect(projection).toContain('if (parsed.page >= pages.length)');
});

test('market order channels are required and each vendor gets its own persisted order anchor', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  expect(projection).toContain('orderChannelId: string | null');
  expect(projection).toContain('orderReadyChannelId: string | null');
  expect(projection).toContain('args.directBuyEnabled && (!args.orderChannelId || !args.orderReadyChannelId)');
  expect(projection).toContain("'Bestellungs-Kanal'");
  expect(projection).toContain("'Bestellung-bereit-Kanal'");
  expect(projection).toContain('orderButtonMessageId: orderMessage?.id ?? null');
  expect(projection).toContain('marketorder:open:v1:${catalogProjectionId}');
  expect(projection).toContain('removeLegacyCatalogMessages(client, projection.id)');
  expect(projection).not.toContain("new ButtonBuilder().setCustomId('marketorder:open:0')");
});

test('new vendor projection migration is additive, scoped and message-safe', () => {
  const migration = read('prisma/migrations/20260901210000_economy_market_vendor_catalog_projection/migration.sql');

  expect(migration).toContain('CREATE TABLE "EconomyMarketVendorCatalogProjection"');
  expect(migration).toContain('FOREIGN KEY ("projectionId", "guildId", "nitradoConnId")');
  expect(migration).toContain('FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")');
  expect(migration).toContain('REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
  expect(migration).toContain('EconomyMarketVendorCatalogProjection_page_check');
  expect(migration).toContain('EconomyMarketVendorCatalogProjection_catalog_message_check');
  expect(migration).toContain('EconomyMarketVendorCatalogProjection_order_message_check');
  expect(migration).not.toContain('DELETE FROM "EconomyMarketDiscordMessage"');
  expect(migration).not.toContain('DROP TABLE');
});

test('legacy order-button constraint remains valid until successful vendor sync removes old rows', () => {
  const migration = read('prisma/migrations/20260901134500_economy_market_order_button_projection_constraint/migration.sql');

  expect(migration).toContain("CHECK (\"kind\" IN ('CATALOG', 'DIRECT_BUY', 'ORDER_BUTTON'))");
  expect(migration).toContain("\"kind\" = 'ORDER_BUTTON'");
  expect(migration).toContain('\"pageIndex\" = 0');
  expect(migration).toContain('\"listingId\" IS NULL');
});
