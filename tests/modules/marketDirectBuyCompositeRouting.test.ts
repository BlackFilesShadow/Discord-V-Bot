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
