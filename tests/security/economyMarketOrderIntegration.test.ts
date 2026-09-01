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
  closeMarketOrder,
  createMarketOrder,
  getMarketOrder,
  listOpenMarketOrders,
} from '../../src/modules/economy/blackMarketOrder';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';
import { describeDb } from '../helpers/dbIntegration';

const guildId = asGuildId('933456789012345678');
const ownerId = asUserDiscordId('933456789012345679');
const buyerId = asUserDiscordId('933456789012345680');
const connId = asNitradoConnId('c555555555555555555555555');

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

describeDb('Schwarzmarkt-Bestellung (Mehrfach-Item-Order)', () => {
  let vendorId = '';
  let otherVendorId = '';

  beforeEach(async () => {
    await cleanup();
    await prisma.nitradoConnection.create({
      data: {
        id: connId,
        guildId,
        slot: 1,
        alias: 'Order-Test',
        alias5: 'ORD01',
        encryptedToken: 'integration-token-order',
        nitradoServerId: '90000010',
        status: 'ACTIVE',
        addedByDiscordId: ownerId,
      },
    });
    await upsertConfig(guildId, connId, { enabled: true, startBalance: 0 });
    await prisma.economyAccount.create({
      data: { guildId, nitradoConnId: connId, userDiscordId: buyerId, walletBalance: 1_000n },
    });
    const vendor = await createVirtualAccount({
      guildId, nitradoConnId: connId, name: 'Schwarzmarkt', kind: 'MARKET_VENDOR', createdByDiscordId: ownerId,
    });
    vendorId = vendor.id;
    const otherVendor = await createVirtualAccount({
      guildId, nitradoConnId: connId, name: 'Weihnachtsmarkt', kind: 'MARKET_VENDOR', createdByDiscordId: ownerId,
    });
    otherVendorId = otherVendor.id;
    await prisma.economyMarketListing.createMany({
      data: [
        { id: 'listing-a', guildId, nitradoConnId: connId, vendorAccountId: vendorId, sku: 'sku-a', name: 'M4A1', price: 300n, stock: 0, createdByDiscordId: ownerId },
        { id: 'listing-b', guildId, nitradoConnId: connId, vendorAccountId: vendorId, sku: 'sku-b', name: 'Magazin', price: 100n, stock: 0, createdByDiscordId: ownerId },
        { id: 'listing-c', guildId, nitradoConnId: connId, vendorAccountId: otherVendorId, sku: 'sku-c', name: 'Baum', price: 50n, stock: 0, createdByDiscordId: ownerId },
      ],
    });
  });

  afterEach(cleanup);

  it('bucht eine Mehrfach-Bestellung als eine Wallet-Abbuchung und legt je Angebot einen PENDING-Kauf an', async () => {
    const key = randomUUID();
    const { booked, order } = await createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-b'], idempotencyKey: key,
    });

    expect(booked).toBe(true);
    expect(order.status).toBe('OPEN');
    expect(order.totalAmount).toBe(400n);
    expect(order.purchases).toHaveLength(2);
    expect(order.purchases.every(purchase => purchase.fulfillmentStatus === 'PENDING')).toBe(true);
    expect(order.purchases.every(purchase => purchase.sourcePocket === 'WALLET')).toBe(true);

    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(600n);

    const vendorRow = await prisma.economyVirtualAccount.findUnique({ where: { id: vendorId } });
    expect(vendorRow?.balance).toBe(400n);
  });

  it('bucht nichts, wenn Angebote unterschiedlichen Haendlern gehoeren', async () => {
    const key = randomUUID();
    await expect(createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-c'], idempotencyKey: key,
    })).rejects.toThrow(/desselben Haendlers/);

    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(1_000n);
    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(0);
  });

  it('bucht nichts bei zu geringem Wallet-Guthaben (atomar, kein Teilkauf)', async () => {
    await prisma.economyAccount.update({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
      data: { walletBalance: 100n },
    });
    const key = randomUUID();
    await expect(createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-b'], idempotencyKey: key,
    })).rejects.toThrow(/Wallet zu klein/);

    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(100n);
    await expect(prisma.economyMarketOrder.count({ where: { guildId } })).resolves.toBe(0);
  });

  it('ist idempotent: derselbe Idempotency-Key bucht kein zweites Mal ab', async () => {
    const key = randomUUID();
    const first = await createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-b'], idempotencyKey: key,
    });
    const second = await createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-b'], idempotencyKey: key,
    });

    expect(first.booked).toBe(true);
    expect(second.booked).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    const account = await prisma.economyAccount.findUnique({
      where: { guildServerUser: { guildId, nitradoConnId: connId, userDiscordId: buyerId } },
    });
    expect(account?.walletBalance).toBe(600n);
  });

  it('schliesst eine Bestellung: alle Kaeufe werden DELIVERED, Status wird CLOSED, ist idempotent', async () => {
    const { order } = await createMarketOrder({
      guildId, nitradoConnId: connId, userDiscordId: buyerId, listingIds: ['listing-a', 'listing-b'], idempotencyKey: randomUUID(),
    });

    const openOrders = await listOpenMarketOrders(guildId, connId, vendorId);
    expect(openOrders.map(row => row.id)).toContain(order.id);

    const closed = await closeMarketOrder({ guildId, nitradoConnId: connId, orderId: order.id, vendorAccountId: vendorId, actorDiscordId: ownerId });
    expect(closed.changed).toBe(true);
    expect(closed.order.status).toBe('CLOSED');
    expect(closed.order.purchases.every(purchase => purchase.fulfillmentStatus === 'DELIVERED')).toBe(true);

    const secondClose = await closeMarketOrder({ guildId, nitradoConnId: connId, orderId: order.id, vendorAccountId: vendorId, actorDiscordId: ownerId });
    expect(secondClose.changed).toBe(false);

    const afterClose = await listOpenMarketOrders(guildId, connId, vendorId);
    expect(afterClose.map(row => row.id)).not.toContain(order.id);

    const reread = await getMarketOrder(guildId, connId, order.id);
    expect(reread?.status).toBe('CLOSED');
  });
});
