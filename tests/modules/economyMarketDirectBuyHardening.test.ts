import fs from 'node:fs';
import path from 'node:path';
import { marketDirectBuyVersion } from '../../src/modules/economy/marketDirectBuyContract';

const root = path.resolve(__dirname, '../..');
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8');

describe('market direct-buy hardening', () => {
  test('version changes whenever a purchase-relevant listing snapshot changes', () => {
    const base = {
      id: 'listing-1',
      vendorAccountId: 'vendor-1',
      price: 2500n,
      updatedAt: new Date('2026-08-31T12:00:00.000Z'),
    };
    const version = marketDirectBuyVersion(base);
    expect(version).toMatch(/^[a-f0-9]{12}$/);
    expect(marketDirectBuyVersion({ ...base, price: 2501n })).not.toBe(version);
    expect(marketDirectBuyVersion({ ...base, vendorAccountId: 'vendor-2' })).not.toBe(version);
    expect(marketDirectBuyVersion({ ...base, updatedAt: new Date('2026-08-31T12:00:01.000Z') })).not.toBe(version);
  });

  test('legacy direct buy remains hardened but is no longer projected as separate messages', () => {
    const contract = read('src/modules/economy/marketDirectBuyContract.ts');
    const interactions = read('src/modules/economy/blackMarketInteractions.ts');
    const purchase = read('src/modules/economy/blackMarketInventoryless.ts');
    const projection = read('src/modules/economy/blackMarketDiscord.ts');

    expect(contract).toContain('m."messageId"=$4');
    expect(contract).toContain('m."channelId"=$3');
    expect(contract).toContain('p."directBuyEnabled"=TRUE');
    expect(contract).toContain('p."directBuyChannelId"=m."channelId"');
    expect(contract).toContain('l."active"=TRUE');
    expect(contract).toContain('l."archivedAt" IS NULL');
    expect(contract).not.toContain('maxPerPurchase');

    expect(interactions).toContain('messageId: interaction.message.id');
    expect(interactions).toContain('message.author.id !== botId');
    expect(interactions).toContain('assertCurrentDiscordMessage');
    expect(interactions).toContain('expectedUnitPrice: context.price');
    expect(interactions).toContain('expectedVendorAccountId: context.vendorAccountId');
    expect(interactions).toContain('expectedUpdatedAt: context.updatedAt');
    expect(interactions).not.toContain('expectedMaxPerPurchase');

    expect(purchase).toContain('expectedUnitPrice?: bigint');
    expect(purchase).toContain('expectedVendorAccountId?: string');
    expect(purchase).toContain('expectedUpdatedAt?: Date');
    expect(purchase).toContain('assertExpectedSnapshot(initial, args)');
    expect(purchase).toContain('assertExpectedSnapshot(listing, args)');
    expect(purchase).toContain('LIMIT 1 FOR UPDATE');
    expect(purchase).not.toContain('args.quantity > listing.maxPerPurchase');
    expect(purchase).not.toContain('listing.stock');

    expect(projection).toContain("row.kind === 'DIRECT_BUY'");
    expect(projection).toContain('await removeProjectionMessage(args.client, row)');
    expect(projection).not.toContain('marketDirectBuyVersion(listing)');
    expect(projection).not.toContain('function directBuyEmbed');
    expect(projection).toContain('fetchManagedMessage');
    expect(projection).toContain('isUnknownDiscordResource(error, 10008)');
    expect(projection).not.toContain('Max. pro Kauf');
  });

  test('a Discord receipt failure after booking is never reported as a rejected purchase', () => {
    const interactions = read('src/modules/economy/blackMarketInteractions.ts');
    const bookingIndex = interactions.indexOf('result = await buyInventorylessMarketListing');
    const confirmationIndex = interactions.indexOf('let confirmationDelivered = false;');
    const confirmationFailureIndex = interactions.indexOf('Discord-Bestätigung nach sicher gebuchtem Direktkauf fehlgeschlagen');
    const syncIndex = interactions.indexOf('if (result.booked)');

    expect(bookingIndex).toBeGreaterThanOrEqual(0);
    expect(confirmationIndex).toBeGreaterThan(bookingIndex);
    expect(confirmationFailureIndex).toBeGreaterThan(confirmationIndex);
    expect(syncIndex).toBeGreaterThan(confirmationIndex);
  });
});
