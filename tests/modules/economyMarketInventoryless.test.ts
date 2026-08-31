import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('market production paths no longer depend on stock or configured per-purchase limits', () => {
  const buy = read('src/modules/economy/blackMarketInventoryless.ts');
  const refund = read('src/modules/economy/blackMarketInventorylessRefund.ts');
  const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
  const command = read('src/commands/dashboard/blackMarket.ts');
  const panel = read('dashboard-ui/src/components/economy/BlackMarketPanel.tsx');

  expect(buy).toContain('LIMIT 1 FOR UPDATE');
  expect(buy).not.toContain('listing.stock');
  expect(buy).not.toContain('"stock"="stock"-$4');
  expect(buy).not.toContain('listing.maxPerPurchase');
  expect(buy).not.toContain('expectedMaxPerPurchase');

  expect(refund).not.toContain('EconomyMarketListing" SET "stock"');
  expect(route).toContain('buyInventorylessMarketListing');
  expect(route).toContain('refundInventorylessMarketPurchase');
  expect(route).toContain('stock: 0');
  expect(route).toContain('maxPerPurchase: 1');

  expect(command).toContain('buyInventorylessMarketListing');
  expect(command).not.toContain('Max. pro Kauf');
  expect(panel).not.toContain('row.stock');
  expect(panel).not.toContain('listing.stock');
  expect(panel).not.toContain('maxPerPurchase');
  expect(panel).not.toContain('Max. pro Kauf');
});
