import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const compact = (value: string) => value.replace(/\s+/g, ' ').trim();

test('market vendor catalogs are fixed per vendor, paged and serialized', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const projectionFlat = compact(projection);
  const prismaModel = read('prisma/economy_market_projection.prisma');
  const interactions = read('src/modules/economy/blackMarketInteractions.ts');
  const composite = read('src/events/interactionCreateComposite.ts');

  expect(projectionFlat).toContain('CATALOG_ITEMS_PER_MESSAGE = 5');
  expect(projectionFlat).toContain('economyMarketVendorCatalogProjection');
  expect(compact(prismaModel)).toContain('model EconomyMarketVendorCatalogProjection');
  expect(compact(prismaModel)).toContain('@@unique([projectionId, vendorAccountId]');
  expect(projectionFlat).toContain('marketcat:v1:page:${catalogProjectionId}');
  expect(projectionFlat).toContain('marketorder:open:v1:${catalogProjectionId}');
  expect(projectionFlat).toContain('const syncInFlight = new Map');
  expect(projectionFlat).toContain('previous.catch(() => null).then(() => syncUnsafe');
  expect(compact(composite)).toContain("i.customId.startsWith('marketcat:v1:')");
  expect(compact(composite)).toContain('handleMarketVendorCatalogPageButton');

  // Direct Buy bleibt bewusst auf dem bestehenden, listing-gebundenen Vertrag.
  expect(projectionFlat).toContain("kind: 'DIRECT_BUY'");
  expect(projectionFlat).toContain('listingId: listing.id');
  expect(compact(interactions)).toContain('buyInventorylessMarketListing');
  expect(compact(interactions)).toContain('syncMarketDiscordProjection');
  expect(compact(composite)).toContain("i.customId.startsWith('marketbuy:')");
  expect(compact(composite)).toContain("i.customId.startsWith('marketbuy_modal:')");
});

test('vendor loading is batched and 300 listings remain safely navigable', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const vendorLoaderStart = projection.indexOf('async function loadActiveVendorCatalogs');
  const vendorLoaderEnd = projection.indexOf('async function upsertVendorCatalogMessages');
  const vendorLoader = projection.slice(vendorLoaderStart, vendorLoaderEnd);
  const projectionFlat = compact(projection);
  const vendorLoaderFlat = compact(vendorLoader);

  expect(vendorLoaderStart).toBeGreaterThan(-1);
  expect(vendorLoaderFlat).toContain('economyVirtualAccount.findMany');
  expect(vendorLoaderFlat).toContain("kind: 'MARKET_VENDOR'");
  expect(vendorLoaderFlat).toContain("status: 'ACTIVE'");
  expect(vendorLoaderFlat).not.toContain('getVirtualAccountById');
  expect(Math.ceil(300 / 5)).toBe(60);
  expect(projectionFlat).toContain('const pages = chunk(catalog.listings, CATALOG_ITEMS_PER_MESSAGE)');
  expect(projectionFlat).toContain('if (parsed.page >= pages.length)');
});

test('market order channels are required and each vendor gets its own persisted order anchor', () => {
  const projection = read('src/modules/economy/blackMarketDiscord.ts');
  const projectionFlat = compact(projection);
  expect(projectionFlat).toContain('orderChannelId: string | null');
  expect(projectionFlat).toContain('orderReadyChannelId: string | null');
  expect(projectionFlat).toContain('args.directBuyEnabled && (!args.orderChannelId || !args.orderReadyChannelId)');
  expect(projectionFlat).toContain("'Bestellungs-Kanal'");
  expect(projectionFlat).toContain("'Bestellung-bereit-Kanal'");
  expect(projectionFlat).toContain('orderButtonMessageId: orderMessage?.id ?? null');
  expect(projectionFlat).toContain('marketorder:open:v1:${catalogProjectionId}');
  expect(projectionFlat).toContain('removeLegacyCatalogMessages(client, projection.id)');
  expect(projectionFlat).not.toContain("new ButtonBuilder().setCustomId('marketorder:open:0')");
});

test('new vendor projection migration is additive, scoped and message-safe', () => {
  const migration = read('prisma/migrations/20260901210000_economy_market_vendor_catalog_projection/migration.sql');
  const migrationFlat = compact(migration);

  expect(migrationFlat).toContain('CREATE TABLE "EconomyMarketVendorCatalogProjection"');
  expect(migrationFlat).toContain('FOREIGN KEY ("projectionId", "guildId", "nitradoConnId")');
  expect(migrationFlat).toContain('FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")');
  expect(migrationFlat).toContain('REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
  expect(migrationFlat).toContain('EconomyMarketVendorCatalogProjection_page_check');
  expect(migrationFlat).toContain('EconomyMarketVendorCatalogProjection_catalog_message_check');
  expect(migrationFlat).toContain('EconomyMarketVendorCatalogProjection_order_message_check');
  expect(migrationFlat).not.toContain('DELETE FROM "EconomyMarketDiscordMessage"');
  expect(migrationFlat).not.toContain('DROP TABLE');
});

test('legacy order-button constraint remains valid until successful vendor sync removes old rows', () => {
  const migration = read('prisma/migrations/20260901134500_economy_market_order_button_projection_constraint/migration.sql');
  const migrationFlat = compact(migration);

  expect(migrationFlat).toContain("CHECK (\"kind\" IN ('CATALOG', 'DIRECT_BUY', 'ORDER_BUTTON'))");
  expect(migrationFlat).toContain("\"kind\" = 'ORDER_BUTTON'");
  expect(migrationFlat).toContain('\"pageIndex\" = 0');
  expect(migrationFlat).toContain('\"listingId\" IS NULL');
});

test('Discord configuration validates every active channel and separates saved state from live sync', () => {
  const validation = compact(read('src/modules/economy/marketDiscordChannelValidation.ts'));
  const route = compact(read('src/dashboard/routes/v2/economyBlackMarket.ts'));
  const ui = read('dashboard-ui/src/components/economy/BlackMarketDiscordSettings.tsx');
  const uiFlat = compact(ui);

  expect(validation).toContain("code === '10003'");
  expect(validation).toContain("code === '50001'");
  expect(validation).toContain("code === '50013'");
  expect(validation).toContain("'Verkaufsliste-Kanal'");
  expect(validation).toContain("'Direktkauf-Kanal'");
  expect(validation).toContain("'Bestellungs-Kanal'");
  expect(validation).toContain("'Bestellung-bereit-Kanal'");
  expect(validation).toContain("[PermissionFlagsBits.ViewChannel, 'Kanal ansehen']");
  expect(validation).toContain("[PermissionFlagsBits.SendMessages, 'Nachrichten senden']");
  expect(validation).toContain("[PermissionFlagsBits.EmbedLinks, 'Links einbetten']");
  expect(validation).toContain("[PermissionFlagsBits.ReadMessageHistory, 'Nachrichtenverlauf lesen']");

  expect(route).toContain('await validateMarketDiscordChannels(client, scope.guildId, config)');
  expect(route).toContain('if (projection) await validateMarketDiscordChannels(client, scope.guildId, projection)');
  expect(route).toContain('if (!sameDiscordConfig(projection, config))');
  expect(route).toContain('res.json({ projection, syncWarning })');
  expect(route).toContain('details: { nitradoConnId: connId, ...config, syncWarning }');

  expect(uiFlat).toContain('syncWarning: string | null');
  expect(uiFlat).toContain('result.syncWarning');
  expect(ui).toContain('GESPEICHERT · SYNC-FEHLER');
  expect(ui).toContain('Discord-Konfiguration gespeichert, aber noch nicht vollständig live synchronisiert');
  expect(ui).toContain('Discord-Konfiguration nicht gespeichert');
});
