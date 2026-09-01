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

  it('begrenzt den gesamten Warenkorb auf maximal 20 Artikel', async () => {
    await expect(createMarketOrderV2({
      guildId,
      nitradoConnId: connId,
      userDiscordId: buyerId,
      sourcePocket: 'WALLET',
      lines: [
        { listingId: 'v2-listing-a', quantity: MAX_MARKET_ORDER_UNITS },
        { listingId: 'v2-listing-b', quantity: 1 },
      ],
      idempotencyKey: randomUUID(),
    })).rejects.toThrow(/maximal 20 Artikel/);

    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(0);
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
    expect(notice?.deleteAt.getTime()).toBe(now.getTime() + 60 * 60_000);
  });
});
