import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('manager order custom ids use one strict parser for button, page and select', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  expect(interactions).toContain('function parseMarketOrderManagerComponentId');
  expect(interactions).toContain("expectedKind === 'vacct_mgr_order' ? 2 : 3");
  expect(interactions).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order')");
  expect(interactions).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_page')");
  expect(interactions).toContain("parseMarketOrderManagerComponentId(interaction.customId, 'vacct_mgr_order_sel')");
  expect(interactions).toContain('String(asNitradoConnId(parts[1]))');
  expect(interactions).toContain("!/^(0|[1-9][0-9]*)$/.test(rawPage)");
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

test('cart supports 25 distinct positions, quantities up to 20 and explicit wallet or bank payment', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  const service = read('src/modules/economy/blackMarketOrderV2.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  expect(service).toContain('MAX_MARKET_ORDER_UNITS = 20');
  expect(service).toContain('MAX_MARKET_ORDER_LINES = 25');
  expect(service).toContain('sourcePocket: args.sourcePocket');
  expect(service).toContain('listing.price * BigInt(quantity)');
  expect(service).toContain('.sort((a, b) => a.listingId.localeCompare(b.listingId))');
  expect(service).toContain('payloadFingerprint(lines, args.sourcePocket)');
  expect(service).toContain('const lockedTotal = rows.reduce');
  expect(service).toContain('lockedTotal !== totalAmount');
  expect(interactions).toContain('marketorder:qty:${token}');
  expect(interactions).toContain('marketorder:pay:w:${token}');
  expect(interactions).toContain('marketorder:pay:b:${token}');
  expect(interactions).toContain('Object.keys(draft.lines).length >= MAX_MARKET_ORDER_LINES');
  expect(interactions).toContain('max. 25 Positionen');
  expect(composite).toContain("i.customId.startsWith('marketorder:pay:')");
  expect(composite).toContain("i.customId.startsWith('marketorder:qty:')");
});

test('strict order replay validates stored order and exact persisted transfer payload', () => {
  const service = read('src/modules/economy/blackMarketOrderV2.ts');

  expect(service).toContain('purchase.sourcePocket === sourcePocket');
  expect(service).toContain('purchase.amount === purchase.unitPrice * BigInt(purchase.quantity)');
  expect(service).toContain('storedTotal !== replay.totalAmount');
  expect(service).toContain('EconomyVirtualAccountEntry');
  expect(service).toContain('entry.virtualAccountId === replay.vendorAccountId');
  expect(service).toContain('entry.delta === replay.totalAmount');
  expect(service).toContain('entry.sourcePocket === sourcePocket');
  expect(service).toContain('entry.sourceRef === `market-order:${args.fingerprint}`');
  expect(service).toContain('entry.userDiscordId === String(args.userDiscordId)');
  expect(service).toContain('Idempotency-Key wurde mit anderen Bestelldaten wiederverwendet.');
  expect(service).toContain('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
  expect(service).toContain("sourceRef: `market-order:${fingerprint}`");
});

test('pending and ready embeds expose the requested lifecycle and one-minute deletion', () => {
  const interactions = read('src/modules/economy/blackMarketOrderInteractionsV2.ts');
  const runtime = read('src/modules/economy/marketOrderReadyRuntime.ts');

  expect(interactions).toContain("setTitle('📦 Bestellung ausstehend')");
  expect(interactions).toContain("name: 'Username'");
  expect(interactions).toContain("name: 'Datum'");
  expect(interactions).toContain("name: 'Uhrzeit'");
  expect(runtime).toContain("setTitle('✅ Bestellung bereit')");
  expect(runtime).toContain('content: `<@${notice.userDiscordId}>`');
  expect(runtime).toContain("{ name: 'Händler'");
  expect(runtime).toContain("{ name: 'Bestellung'");
  expect(runtime).toContain("{ name: 'Artikel'");
  expect(runtime).toContain('READY_TTL_MS = 60_000');
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
  expect(projection).toContain('**Wallet oder Bank**');
});
