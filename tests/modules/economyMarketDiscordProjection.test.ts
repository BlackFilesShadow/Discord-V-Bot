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
