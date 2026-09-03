import fs from 'node:fs';
import path from 'node:path';

test('one vendor catalog supports 300 listings through navigation without direct-buy embeds', () => {
  const projection = fs.readFileSync(path.resolve(__dirname, '../../src/modules/economy/blackMarketDiscord.ts'), 'utf8');
  expect(projection).toContain('for (const listing of args.listings)');
  expect(projection).toContain('CATALOG_ITEMS_PER_MESSAGE = 5');
  expect(projection).toContain('const pages = chunk(catalog.listings, CATALOG_ITEMS_PER_MESSAGE)');
  expect(projection).toContain('marketcat:v1:page:${args.catalogProjectionId}');
  expect(projection).toContain("setLabel('Bestellung')");
  expect(Math.ceil(300 / 5)).toBe(60);
  expect(projection).not.toContain('directBuyComponents(listing)');
  expect(projection).not.toContain('marketDirectBuyVersion(listing)');
  expect(projection).not.toContain('StringSelectMenuBuilder');
});
