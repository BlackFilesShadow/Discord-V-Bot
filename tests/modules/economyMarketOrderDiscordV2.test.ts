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

test('vendor order anchor is strict, persisted and binds the cart before item selection', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');

  expect(interactions).toContain("if (customId === 'marketorder:open:0') return null");
  expect(interactions).toContain("parts.length !== 4");
  expect(interactions).toContain("parts[2] !== 'v1'");
  expect(interactions).toContain('EconomyMarketVendorCatalogProjection');
  expect(interactions).toContain('c."orderButtonMessageId"=$4');
  expect(interactions).toContain('p."catalogChannelId"=c."channelId"');
  expect(interactions).toContain("v.\"kind\"='MARKET_VENDOR'");
  expect(interactions).toContain("v.\"status\"='ACTIVE'");
  expect(interactions).toContain('AND EXISTS (');
  expect(interactions).toContain('interaction.message.author.id !== interaction.client.user.id');
  expect(interactions).toContain('vendorAccountId: context.vendorAccountId');
});

test('vendor-bound cart never exposes listings from another vendor and rejects inactive vendors', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');

  expect(interactions).toContain('allListings.filter(listing => listing.vendorAccountId === draft.vendorAccountId)');
  expect(interactions).toContain("boundVendor.kind !== 'MARKET_VENDOR'");
  expect(interactions).toContain("boundVendor.status !== 'ACTIVE'");
  expect(interactions).toContain('draft.vendorAccountId !== listing.vendorAccountId');
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

test('vendor catalog renders compact article, price and currency without N+1 vendor lookup', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const loaderStart = projection.indexOf('async function loadActiveVendorCatalogs');
  const loaderEnd = projection.indexOf('async function upsertVendorCatalogMessages');
  const loader = projection.slice(loaderStart, loaderEnd);

  expect(projection).toContain('vendorCatalogEmbed');
  expect(projection).toContain('safeEmbedField(listing.name, 250)');
  expect(projection).toContain('listing.price.toLocaleString');
  expect(projection).toContain('safeEmbedField(args.currencyName, 120)');
  expect(loader).toContain('economyVirtualAccount.findMany');
  expect(loader).not.toContain('getVirtualAccountById');
  expect(projection).toContain('bis zu **20 Artikeln**');
  expect(projection).toContain('**Wallet oder Bank**');
});
