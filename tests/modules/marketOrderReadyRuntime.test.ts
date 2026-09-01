jest.mock('../../src/database/prisma', () => {
  const prisma: Record<string, any> = {
    economyMarketOrderReadyNotice: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  return { __esModule: true, default: prisma };
});

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import { runMarketOrderReadyCleanupOnce } from '../../src/modules/economy/marketOrderReadyRuntime';

const db = prisma as any;
const getClient = tryGetDashboardClient as jest.Mock;
const NOW = new Date('2026-09-01T00:02:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  db.economyMarketOrderReadyNotice.updateMany.mockResolvedValue({ count: 1 });
});

describe('Schwarzmarkt-Bestellung Ready-Notice Cleanup', () => {
  it('loescht eine faellige Mention-Nachricht und markiert die Notice als erledigt', async () => {
    db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([{
      id: 'notice-1', orderId: 'order-1', guildId: 'g1', nitradoConnId: 'n1', channelId: 'channel-1', messageId: 'msg-1',
    }]);
    const del = jest.fn().mockResolvedValue(undefined);
    const channel = {
      type: 0,
      messages: { fetch: jest.fn().mockResolvedValue({ delete: del }) },
    };
    getClient.mockReturnValue({ channels: { fetch: jest.fn().mockResolvedValue(channel) } });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(del).toHaveBeenCalledTimes(1);
    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-1', orderId: 'order-1', guildId: 'g1', nitradoConnId: 'n1', deletedAt: null },
      data: { deletedAt: NOW },
    }));
  });

  it('markiert die Notice trotzdem als erledigt, wenn die Nachricht bereits verschwunden ist', async () => {
    db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([{
      id: 'notice-2', orderId: 'order-2', guildId: 'g1', nitradoConnId: 'n1', channelId: 'channel-1', messageId: 'msg-2',
    }]);
    const channel = {
      type: 0,
      messages: { fetch: jest.fn().mockRejectedValue({ code: 10008 }) },
    };
    getClient.mockReturnValue({ channels: { fetch: jest.fn().mockResolvedValue(channel) } });

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(db.economyMarketOrderReadyNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-2', orderId: 'order-2', guildId: 'g1', nitradoConnId: 'n1', deletedAt: null },
    }));
  });

  it('laedt nur Notices mit deletedAt=null und faelliger deleteAt', async () => {
    db.economyMarketOrderReadyNotice.findMany.mockResolvedValue([]);

    await runMarketOrderReadyCleanupOnce(NOW);

    expect(db.economyMarketOrderReadyNotice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { deletedAt: null, deleteAt: { lte: NOW } },
    }));
    expect(getClient).not.toHaveBeenCalled();
  });
});
