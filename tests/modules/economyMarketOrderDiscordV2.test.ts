import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('manager order custom ids read the actual connId segment instead of undefined', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  expect(interactions).toContain("interaction.customId.split(':')[1]");
  expect(interactions).toContain('vacct_mgr_order_sel:${connId}');
  expect(interactions).not.toContain("interaction.customId.split(':')[2];\n  try {\n    if (!interaction.guildId) throw new Error('Nur auf einem Discord-Server verfügbar.');\n    const guildId");
});

test('cart supports quantities up to 20 and explicit wallet or bank payment', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  const service = read('src/modules/economy/blackMarketOrderV2.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  expect(service).toContain('MAX_MARKET_ORDER_UNITS = 20');
  expect(service).toContain('sourcePocket: args.sourcePocket');
  expect(service).toContain('listing.price * BigInt(quantity)');
  expect(interactions).toContain('marketorder:qty:${token}');
  expect(interactions).toContain('marketorder:pay:w:${token}');
  expect(interactions).toContain('marketorder:pay:b:${token}');
  expect(composite).toContain("i.customId.startsWith('marketorder:pay:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:qty:')");
});

test('pending and ready embeds expose the requested lifecycle and one-hour deletion', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  const service = read('src/modules/economy/blackMarketOrderV2.ts');

  expect(interactions).toContain("setTitle('📦 Bestellung ausstehend')");
  expect(interactions).toContain("name: 'Username'");
  expect(interactions).toContain("name: 'Datum'");
  expect(interactions).toContain("name: 'Uhrzeit'");
  expect(interactions).toContain("setTitle('✅ Bestellung fertig')");
  expect(interactions).toContain('content: `<@${userDiscordId}>`');
  expect(service).toContain('60 * 60_000');
});

test('catalog groups by virtual account and renders article beside price and currency', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  expect(projection).toContain('vendorNames: Map<string, string>');
  expect(projection).toContain("name: 'Artikel'");
  expect(projection).toContain("name: 'Preis / Währung'");
  expect(projection).toContain('inline: true');
  expect(projection).toContain('getVirtualAccountById');
  expect(projection).toContain('bis zu **20 Artikeln**');
  expect(projection).toContain('**Wallet oder Bank**');
});
