import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('market catalog and direct-buy projections are paged and serialized', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const interactions = read('src/modules/economy/blackMarketInteractions.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  expect(projection).toContain('CATALOG_ITEMS_PER_MESSAGE = 5');
  expect(projection).toContain("kind: 'DIRECT_BUY'");
  expect(projection).toContain('listingId: listing.id');
  expect(projection).toContain('const syncInFlight = new Map');
  expect(projection).toContain('previous.catch(() => null).then(() => syncUnsafe');
  expect(interactions).toContain('buyInventorylessMarketListing');
  expect(interactions).toContain('syncMarketDiscordProjection');
  expect(composite).toContain("customId.startsWith('marketbuy:')");
  expect(composite).toContain("customId.startsWith('marketbuy_modal:')");
});

test('market order channels are required whenever direct-buy is enabled', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  expect(projection).toContain('orderChannelId: string | null');
  expect(projection).toContain('orderReadyChannelId: string | null');
  expect(projection).toContain('args.directBuyEnabled && (!args.orderChannelId || !args.orderReadyChannelId)');
  expect(projection).toContain("'Bestellungs-Kanal'");
  expect(projection).toContain("'Bestellung-bereit-Kanal'");
  expect(projection).toContain("kind: 'ORDER_BUTTON'");
  expect(projection).toContain('channel: catalogChannel');
  expect(projection).toContain("setCustomId('marketorder:open:0')");
});

test('database constraints allow the catalog-wide order button written by runtime', () => {
  const migration = read('prisma/migrations/20260901134500_economy_market_order_button_projection_constraint/migration.sql');

  expect(migration).toContain("CHECK (\"kind\" IN ('CATALOG', 'DIRECT_BUY', 'ORDER_BUTTON'))");
  expect(migration).toContain("\"kind\" = 'ORDER_BUTTON'");
  expect(migration).toContain('\"pageIndex\" = 0');
  expect(migration).toContain('\"listingId\" IS NULL');
});
