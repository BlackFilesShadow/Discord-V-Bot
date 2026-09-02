jest.mock('../../src/database/prisma', () => {
  const prisma: Record<string, any> = {
    $transaction: jest.fn(),
    economyMarketDiscordProjection: { findUnique: jest.fn() },
    economyMarketOrderReadyNotice: { findMany: jest.fn(), updateMany: jest.fn() },
  };
  return { __esModule: true, default: prisma };
});

jest.mock('../../src/dashboard/clientRegistry', () => ({ tryGetDashboardClient: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, logAudit: jest.fn() }));

import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { runMarketOrderReadyCleanupOnce } from '../../src/modules/economy/marketOrderReadyRuntime';

const db = prisma as any;
const getClient = tryGetDashboardClient as jest.Mock;
const NOW = new Date('2026-09-01T00:02:00.000Z');
let rawRows: any[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  rawRows = [];
  db.$transaction.mockImplementation(async (fn: any) => fn({
    $queryRawUnsafe: jest.fn().mockImplementation(async () => rawRows),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  }));
  db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([]);
  db.economyMarketOrderReadyNotice.updateMany.mockResolvedValue({ count: 1 });
});

describe('Schwarzmarkt-Bestellung Ready-Outbox', () => {
  it('claimed eine PENDING Notice, sendet genau eine Mention und markiert SENT mit einer Stunde TTL', async () => {
    rawRows = [{ id: 'notice-1', orderId: 'order-1', guildId: 'g1', nitradoConnId: 'n1', channelId: null, userDiscordId: 'u1', messageId: null, attempts: 0 }];
    db.economyMarketDiscordProjection.findUnique.mockResolvedValue({ orderReadyChannelId: 'ready-1' });
    const send = jest.fn().mockResolvedValue({ id: 'msg-ready' });
    getClient.mockReturnValue({ channels: { fetch: jest.fn().mockResolvedValue({ id: 'ready-1', type: 0, send, messages: { fetch: jest.fn() } }) } });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(send).toHaveBeenCalledTimes(1);
    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-1', orderId: 'order-1', status: 'SENDING' },
      data: expect.objectContaining({ status: 'SENT', messageId: 'msg-ready', deleteAt: new Date(NOW.getTime() + 60 * 60_000) }),
    }));
  });

  it('setzt einen fehlgeschlagenen Send retryfaehig auf PENDING zurueck', async () => {
    rawRows = [{ id: 'notice-2', orderId: 'order-2', guildId: 'g1', nitradoConnId: 'n1', channelId: null, userDiscordId: 'u2', messageId: null, attempts: 0 }];
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
      id: 'notice-3', orderId: 'order-3', guildId: 'g1', nitradoConnId: 'n1', channelId: 'channel-1', userDiscordId: 'u3', messageId: 'msg-3', attempts: 1,
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
