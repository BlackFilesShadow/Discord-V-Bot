import fs from 'node:fs';
import path from 'node:path';

test('direct buy uses per-listing versioned messages instead of a bounded Discord select', () => {
  const projection = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/blackMarketDiscord.ts'), 'utf8');
  expect(projection).toContain('for (const listing of args.listings)');
  expect(projection).toContain('directBuyComponents(listing)');
  expect(projection).toContain('marketDirectBuyVersion(listing)');
  expect(projection).toContain('marketbuy:w:${listing.id}:${version}');
  expect(projection).toContain('marketbuy:b:${listing.id}:${version}');
  expect(projection).not.toContain('StringSelectMenuBuilder');
});
