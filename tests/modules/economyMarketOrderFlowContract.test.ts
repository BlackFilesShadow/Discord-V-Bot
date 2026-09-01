import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const interactions = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrderInteractionsV2.ts'), 'utf8');

test('production order flow keeps paid -> pending -> manager close -> ready lifecycle', () => {
  expect(interactions).toContain("setTitle('📦 Bestellung ausstehend')");
  expect(interactions).toContain("setTitle('✅ Bestellung fertig')");
  expect(interactions).toContain("Bestellung nach Username auswählen");
  expect(interactions).toContain('scheduleMarketOrderReadyNoticeOneHour');
  expect(interactions).toContain('postOrderChannelEmbed(interaction.client');
  expect(interactions).toContain('postOrderReadyEmbed(interaction.client');
});
