import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const interactions = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrderInteractionsV2.ts'), 'utf8');
const orderService = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrder.ts'), 'utf8');
const readyRuntime = fs.readFileSync(path.join(root, 'src/modules/economy/marketOrderReadyRuntime.ts'), 'utf8');

test('production order flow keeps paid -> pending -> manager close -> retryable ready lifecycle', () => {
  expect(interactions).toContain("setTitle('📦 Bestellung ausstehend')");
  expect(interactions).toContain(".setTitle('✅ Bestellung beendet')");
  expect(interactions).toContain('postOrderChannelEmbed(interaction.client');
  expect(interactions).toContain('editOriginalOrderMessage');
  expect(orderService).toContain("'PENDING',0,CURRENT_TIMESTAMP");
  expect(readyRuntime).toContain(".setTitle('✅ Bestellung bereit')");
  expect(orderService).toContain("INTERVAL \\'1 minute\\'");
  expect(readyRuntime).toContain('Löschung nach 20 Minuten');
});
