import fs from 'node:fs';
import path from 'node:path';

test('market API strips the legacy stock field from listing responses', () => {
  const route = fs.readFileSync(path.resolve(__dirname, '../../src/dashboard/routes/v2/economyBlackMarket.ts'), 'utf8');
  expect(route).toContain('const { stock: _legacyStock, ...rest } = row;');
  expect(route).toContain('return { ...rest, price: row.price.toString() };');
});
