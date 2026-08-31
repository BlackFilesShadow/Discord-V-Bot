import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

test('dashboard exposes sale-list channel and independently switchable direct-buy channel', () => {
  const ui = fs.readFileSync(path.join(root, 'dashboard-ui/src/components/economy/BlackMarketDiscordSettings.tsx'), 'utf8');
  expect(ui).toContain('Kanal für Verkaufsliste');
  expect(ui).toContain('Direktkauf aktivieren');
  expect(ui).toContain('Direktkauf-Kanal wählen');
  expect(ui).toContain('Speichern & sofort synchronisieren');
});
