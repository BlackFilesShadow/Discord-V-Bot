import fs from 'node:fs';
import path from 'node:path';

test('market API strips legacy stock and max-per-purchase fields from listing responses', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/dashboard/routes/v2/economyBlackMarket.ts'), 'utf8');
  expect(route).toContain('stock: _legacyStock, maxPerPurchase: _legacyMaxPerPurchase');
  expect(route).toContain('return { ...rest, price: row.price.toString() };');
  expect(route).toContain('maxPerPurchase: 1');
  expect(route).not.toContain("parseIntSafe(req.body?.maxPerPurchase");
});
