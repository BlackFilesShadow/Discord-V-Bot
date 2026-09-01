import fs from 'node:fs';
import path from 'node:path';

test('market direct-buy components use the existing global component rate limit', () => {
  const composite = fs.readFileSync(path.resolve(__dirname, '../../src/events/interactionCreateComposite.ts'), 'utf8');
  expect(composite).toContain("i.customId.startsWith('marketbuy:')");
  expect(composite).toContain("i.customId.startsWith('marketbuy_modal:')");
  expect(composite).toContain('checkComponentRateLimit(i.user.id)');
  expect(composite).toContain('handleMarketDirectBuyButton');
  expect(composite).toContain('handleMarketDirectBuyModal');
});

test('market order (Sammelbestellung) components are routed under the same composite rate limit', () => {
  const composite = fs.readFileSync(path.resolve(__dirname, '../../src/events/interactionCreateComposite.ts'), 'utf8');
  expect(composite).toContain("i.customId.startsWith('marketorder:open:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:page:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:add:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:pay:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:confirm:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:cancel:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:item:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:qty:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:select:')");
  expect(composite).toContain("i.customId.startsWith('vacct_mgr_order:')");
  expect(composite).toContain("i.customId.startsWith('vacct_mgr_order_sel:')");
  expect(composite).toContain('handleMarketOrderButton');
  expect(composite).toContain('handleMarketOrderPageButton');
  expect(composite).toContain('handleMarketOrderAddButton');
  expect(composite).toContain('handleMarketOrderPayButton');
  expect(composite).toContain('handleMarketOrderItemSelect');
  expect(composite).toContain('handleMarketOrderQuantitySelect');
  expect(composite).toContain('handleLegacyMarketOrderSelect');
  expect(composite).toContain('handleLegacyMarketOrderConfirmButton');
  expect(composite).toContain('handleMarketOrderCancelButton');
  expect(composite).toContain('handleMarketOrderManagerButton');
  expect(composite).toContain('handleMarketOrderManagerSelect');
});
