import fs from 'node:fs';
import path from 'node:path';

test('direct buy uses per-listing messages instead of a bounded Discord select', () => {
  const projection = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/blackMarketDiscord.ts'), 'utf8');
  expect(projection).toContain('for (const listing of args.listings)');
  expect(projection).toContain('directBuyComponents(listing.id)');
  expect(projection).not.toContain('StringSelectMenuBuilder');
});
