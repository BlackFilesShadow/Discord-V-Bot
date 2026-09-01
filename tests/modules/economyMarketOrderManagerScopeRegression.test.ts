import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/modules/economy/blackMarketOrderInteractionsV2.ts'), 'utf8');

test('Bestellung abschließen reads connId from vacct_mgr_order:<connId>', () => {
  expect(source).toContain("export async function handleMarketOrderManagerButton");
  expect(source).toContain("const connId = interaction.customId.split(':')[1];");
  expect(source).toContain(".setCustomId(`vacct_mgr_order_sel:${connId}`)");
  expect(source).toContain("export async function handleMarketOrderManagerSelect");
});
