jest.mock('../../src/database/prisma', () => {
  const prisma: Record<string, any> = {
    $transaction: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    economyMarketDiscordProjection: { findUnique: jest.fn() },
    economyMarketListing: { findMany: jest.fn() },
    economyMarketOrderReadyNotice: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { __esModule: true, default: prisma };
});

jest.mock('../../src/dashboard/clientRegistry', () => ({ tryGetDashboardClient: jest.fn() }));
jest.mock('../../src/modules/economy/blackMarketOrder', () => ({ getMarketOrder: jest.fn() }));
jest.mock('../../src/modules/economy/repository', () => ({ getConfig: jest.fn() }));
jest.mock('../../src/modules/economy/virtualAccounts', () => ({ getVirtualAccountById: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, logAudit: jest.fn() }));

import { createHash } from 'node:crypto';
import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { getMarketOrder } from '../../src/modules/economy/blackMarketOrder';
import { runMarketOrderReadyCleanupOnce } from '../../src/modules/economy/marketOrderReadyRuntime';
import { getConfig } from '../../src/modules/economy/repository';
import { getVirtualAccountById } from '../../src/modules/economy/virtualAccounts';

const db = prisma as any;
const getClient = tryGetDashboardClient as jest.Mock;
const getOrder = getMarketOrder as jest.Mock;
const getEconomyConfig = getConfig as jest.Mock;
const getVendor = getVirtualAccountById as jest.Mock;
const NOW = new Date('2026-09-01T00:02:00.000Z');
const GUILD_ID = '943456789012345678';
const CONN_ID = 'c999999999999999999999999';
let rawRows: any[] = [];

function expectedReadyNonce(noticeId: string): string {
  return createHash('sha256')
    .update(`market-ready\u0000${noticeId}`)
    .digest('hex')
    .slice(0, 25);
}

beforeEach(() => {
  jest.clearAllMocks();
  rawRows = [];
  db.$transaction.mockImplementation(async (fn: any) => fn({
    $queryRawUnsafe: jest.fn().mockImplementation(async () => {
      const rows = rawRows;
      rawRows = [];
      return rows;
    }),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  }));
  db.economyMarketDiscordProjection.findUnique.mockResolvedValue({ orderReadyChannelId: 'ready-1' });
  db.economyMarketListing.findMany.mockResolvedValue([{ id: 'listing-1', name: 'M4A1' }]);
  db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([]);
  db.economyMarketOrderReadyNotice.updateMany.mockResolvedValue({ count: 1 });
  db.$queryRawUnsafe.mockResolvedValue([]);
  db.$executeRawUnsafe.mockResolvedValue(1);
  getOrder.mockResolvedValue({
    id: 'order-1',
    status: 'CLOSED',
    userDiscordId: 'u1',
    vendorAccountId: 'vendor-1',
    totalAmount: 100n,
    purchases: [{
      listingId: 'listing-1',
      quantity: 2,
      unitPrice: 50n,
      amount: 100n,
      deliveryItems: [],
    }],
  });
  getVendor.mockResolvedValue({ id: 'vendor-1', name: 'Blackstone Trading' });
  getEconomyConfig.mockResolvedValue({ emoji: '🪙', currencyName: 'Credits' });
});

describe('Schwarzmarkt-Bestellung Ready-Outbox', () => {
  it('claimed eine PENDING Notice, sendet genau eine deduplizierte Mention und markiert SENT mit 20 Minuten TTL', async () => {
    rawRows = [{ id: 'notice-1', orderId: 'order-1', guildId: GUILD_ID, nitradoConnId: CONN_ID, channelId: null, userDiscordId: 'u1', messageId: null, attempts: 0 }];
    const send = jest.fn().mockResolvedValue({ id: 'msg-ready' });
    const find = jest.fn().mockReturnValue(undefined);
    getClient.mockReturnValue({
      user: { id: 'bot-1' },
      channels: { fetch: jest.fn().mockResolvedValue({ id: 'ready-1', type: 0, send, messages: { fetch: jest.fn().mockResolvedValue({ find }) } }) },
    });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      content: '<@u1>',
      allowedMentions: { users: ['u1'] },
      nonce: expectedReadyNonce('notice-1'),
      enforceNonce: true,
    }));
    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-1', orderId: 'order-1', status: 'SENDING' },
      data: expect.objectContaining({ status: 'SENT', messageId: 'msg-ready', deleteAt: new Date(NOW.getTime() + 20 * 60_000) }),
    }));
  });

  it('reconciled einen bereits gesendeten Outbox-Marker ohne zweite Mention', async () => {
    rawRows = [{ id: 'notice-recovered', orderId: 'order-1', guildId: GUILD_ID, nitradoConnId: CONN_ID, channelId: null, userDiscordId: 'u1', messageId: null, attempts: 1 }];
    const send = jest.fn();
    const existingMessage = { id: 'msg-existing', author: { id: 'bot-1' }, embeds: [{ footer: { text: 'V-Bot · Outbox:notice-recovered' } }] };
    const recent = { find: jest.fn().mockReturnValue(existingMessage) };
    getClient.mockReturnValue({
      user: { id: 'bot-1' },
      channels: { fetch: jest.fn().mockResolvedValue({ id: 'ready-1', type: 0, send, messages: { fetch: jest.fn().mockResolvedValue(recent) } }) },
    });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(send).not.toHaveBeenCalled();
    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-recovered', orderId: 'order-1', status: 'SENDING' },
      data: expect.objectContaining({ status: 'SENT', messageId: 'msg-existing' }),
    }));
  });

  it('setzt einen fehlgeschlagenen Send retryfaehig auf PENDING zurueck', async () => {
    rawRows = [{ id: 'notice-2', orderId: 'order-2', guildId: GUILD_ID, nitradoConnId: CONN_ID, channelId: null, userDiscordId: 'u2', messageId: null, attempts: 0 }];
    db.economyMarketDiscordProjection.findUnique.mockResolvedValue({ orderReadyChannelId: 'ready-1' });
    getClient.mockReturnValue({ channels: { fetch: jest.fn().mockRejectedValue(new Error('discord down')) } });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-2', orderId: 'order-2', status: 'SENDING' },
      data: expect.objectContaining({ status: 'PENDING', leaseUntil: null, lastError: 'discord down' }),
    }));
  });

  it('loescht eine faellige SENT-Nachricht und markiert die Notice als erledigt', async () => {
    db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([{
      id: 'notice-3', orderId: 'order-3', guildId: GUILD_ID, nitradoConnId: CONN_ID, channelId: 'channel-1', userDiscordId: 'u3', messageId: 'msg-3', attempts: 1,
    }]);
    const del = jest.fn().mockResolvedValue(undefined);
    getClient.mockReturnValue({ channels: { fetch: jest.fn().mockResolvedValue({ type: 0, messages: { fetch: jest.fn().mockResolvedValue({ delete: del }) } }) } });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(del).toHaveBeenCalledTimes(1);
    expect(db.economyMarketOrderReadyNotice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'SENT', deletedAt: null, deleteAt: { lte: NOW } },
    }));
    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { deletedAt: NOW } }));
  });
});