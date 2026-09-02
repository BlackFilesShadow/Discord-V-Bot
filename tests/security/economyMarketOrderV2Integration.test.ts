process.env.NODE_ENV = 'test';
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import { randomUUID } from 'node:crypto';
import prisma from '../../src/database/prisma';
import { upsertConfig } from '../../src/modules/economy/repository';
import { createVirtualAccount } from '../../src/modules/economy/virtualAccounts';
import {
  createMarketOrderV2,
  MAX_MARKET_ORDER_LINES,
  MAX_MARKET_ORDER_UNITS,
  scheduleMarketOrderReadyNoticeOneHour,
} from '../../src/modules/economy/blackMarketOrderV2';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';
import { describeDb } from '../helpers/dbIntegration';

const guildId = asGuildId('943456789012345678');
const ownerId = asUserDiscordId('943456789012345679');
const buyerId = asUserDiscordId('943456789012345680');
const connId = asNitradoConnId('c666666666666666666666666');

async function cleanup(): Promise<void> {
  await prisma.economyMarketOrderReadyNotice.deleteMany({ where: { guildId } });
  await prisma.economyMarketPurchase.deleteMany({ where: { guildId } });
  await prisma.economyMarketOrder.deleteMany({ where: { guildId } });
  await prisma.economyMarketListing.deleteMany({ where: { guildId } });
  await prisma.economyVirtualAccountEntry.deleteMany({ where: { guildId } });
  await prisma.economyVirtualAccount.deleteMany({ where: { guildId } });
  await prisma.economyLedgerEntry.deleteMany({ where: { guildId } });
  await prisma.economyTransaction.deleteMany({ where: { guildId } });
  await prisma.economyAccount.deleteMany({ where: { guildId } });
  await prisma.economyConfig.deleteMany({ where: { guildId } });
  await prisma.nitradoConnection.deleteMany({ where: { guildId } });
}

describeDb('Schwarzmarkt-Bestellung V2 (Mengen + Wallet/Bank)', () => {
  let vendorId = '';

  beforeEach(async () => {
    await cleanup();
    await prisma.nitradoConnection.create({
      data: {
        id: connId,
        guildId,
        slot: 1,
        alias: 'Order-V2-Test',
        alias5: 'ORV02',
        encryptedToken: 'integration-token-order-v2',
        nitradoServerId: '90000011',
        status: 'ACTIVE',
        addedByDiscordId: ownerId,
      },
    });
    await upsertConfig(guildId, connId, { enabled: true, startBalance: 0 });
    await prisma.economyAccount.create({
      data: { guildId, nitradoConnId: connId, userDiscordId: buyerId, walletBalance: 1_000n, bankBalance: 1_000n },
    });
    const vendor = await createVirtualAccount({
      guildId,
      nitradoConnId: connId,
      name: 'Blackstone Trading',
      kind: 'MARKET_VENDOR',
      createdByDiscordId: ownerId,
    });
    vendorId = vendor.id;
    await prisma.economyMarketListing.createMany({
      data: [
        { id: 'v2-listing-a', guildId, nitradoConnId: connId, vendorAccountId: vendorId, sku: 'V2-A', name: 'M4A1', price: 100n, stock: 0, createdByDiscordId: ownerId },
        { id: 'v2-listing-b', guildId, nitradoConnId: connId, vendorAccountId: vendorId, sku: 'V2-B', name: 'Magazin', price: 50n, stock: 0, createdByDiscordId: ownerId },
      ],
    });
  });

  afterEach(cleanup);

  it('bucht mehrere Mengen atomar aus der Bank und speichert die echten Mengen', async () => {
    const result = await createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'BANK',
      lines: [
        { listingId: 'v2-listing-a', quantity: 3 },
        { listingId: 'v2-listing-b', quantity: 2 },
      ],
      idempotencyKey: randomUUID(),
    });

    expect(result.booked).toBe(true);
    expect(result.order.status).toBe('OPEN');
    expect(result.order.totalAmount).toBe(400n);
    expect(result.order.purchases).toHaveLength(2);
    expect(result.order.purchases.every(purchase => purchase.sourcePocket === 'BANK')).toBe(true);
    expect(result.order.purchases.find(purchase => purchase.listingId === 'v2-listing-a')?.quantity).toBe(3);
    expect(result.order.purchases.find(purchase => purchase.listingId === 'v2-listing-b')?.quantity).toBe(2);

    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.bankBalance).toBe(600n);
    expect(account?.walletBalance).toBe(1_000n);

    const vendor = await prisma.economyVirtualAccount.findUnique({ where: { id: vendorId } });
    expect(vendor?.balance).toBe(400n);
  });

  it('begrenzt jede einzelne Position auf maximal 20 Stück', async () => {
    await expect(createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [{ listingId: 'v2-listing-a', quantity: MAX_MARKET_ORDER_UNITS + 1 }],
      idempotencyKey: randomUUID(),
    })).rejects.toThrow(/Menge muss zwischen 1 und 20/);

    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(0);
  });

  it('erlaubt 25 verschiedene Positionen unabhängig von der Gesamtstückzahl', async () => {
    const listings = Array.from({ length: MAX_MARKET_ORDER_LINES }, (_, index) => ({
      id: `v2-extra-${String(index).padStart(2, '0')}`,
      guildId,
      nitradoConnId: connId,
      vendorAccountId: vendorId,
      sku: `V2-X-${String(index).padStart(2, '0')}`,
      name: `Extra ${index}`,
      price: 1n,
      stock: 0,
      createdByDiscordId: ownerId,
    }));
    await prisma.economyMarketListing.createMany({ data: listings });

    const result = await createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: listings.map((listing, index) => ({ listingId: listing.id, quantity: index === 0 ? 20 : 1 })),
      idempotencyKey: randomUUID(),
    });

    expect(result.booked).toBe(true);
    expect(result.order.purchases).toHaveLength(MAX_MARKET_ORDER_LINES);
    expect(result.order.totalAmount).toBe(44n);
    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(956n);
  });

  it('lehnt eine 26. verschiedene Position vor jeder Buchung ab', async () => {
    const lines = Array.from({ length: MAX_MARKET_ORDER_LINES + 1 }, (_, index) => ({
      listingId: `over-limit-${String(index).padStart(2, '0')}`,
      quantity: 1,
    }));

    await expect(createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines,
      idempotencyKey: randomUUID(),
    })).rejects.toThrow(/maximal 25 verschiedene Artikel/);

    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(0);
  });

  it('replayed nur exakt denselben kanonischen Warenkorb und Zahlungsweg', async () => {
    const idempotencyKey = 'phase4-replay-key';
    const first = await createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [
        { listingId: 'v2-listing-a', quantity: 2 },
        { listingId: 'v2-listing-b', quantity: 1 },
      ],
      idempotencyKey,
    });

    const replay = await createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [
        { listingId: 'v2-listing-b', quantity: 1 },
        { listingId: 'v2-listing-a', quantity: 2 },
      ],
      idempotencyKey,
    });
    expect(replay.booked).toBe(false);
    expect(replay.order.id).toBe(first.order.id);

    await expect(createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [
        { listingId: 'v2-listing-a', quantity: 3 },
        { listingId: 'v2-listing-b', quantity: 1 },
      ],
      idempotencyKey,
    })).rejects.toThrow(/anderen Bestelldaten/);

    await expect(createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'BANK',
      lines: [
        { listingId: 'v2-listing-a', quantity: 2 },
        { listingId: 'v2-listing-b', quantity: 1 },
      ],
      idempotencyKey,
    })).rejects.toThrow(/anderen Bestelldaten/);

    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(1);
    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(750n);
    expect(account?.bankBalance).toBe(1_000n);
  });

  it('plant die Bestellung-fertig-Nachricht restart-sicher fuer genau eine Stunde', async () => {
    const result = await createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [{ listingId: 'v2-listing-a', quantity: 1 }],
      idempotencyKey: randomUUID(),
    });
    const now = new Date('2026-09-01T12:00:00.000Z');
    await scheduleMarketOrderReadyNoticeOneHour({
      guildId,
      nitradoConnId: connId,
      orderId: result.order.id,
      channelId: '943456789012345681',
      userDiscordId: buyerId,
      messageId: '943456789012345682',
      now,
    });

    const notice = await prisma.economyMarketOrderReadyNotice.findUnique({ where: { orderId: result.order.id } });
    expect(notice?.deleteAt?.getTime()).toBe(now.getTime() + 60 * 60_000);
  });
});