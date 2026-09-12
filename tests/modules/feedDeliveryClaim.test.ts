const createMock = jest.fn();
const deleteMock = jest.fn();
const deleteManyMock = jest.fn();
const updateMock = jest.fn();
const loggerInfo = jest.fn();
const loggerWarn = jest.fn();
const loggerError = jest.fn();
const logAudit = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    idempotencyKey: {
      create: (...args: unknown[]) => createMock(...args),
      delete: (...args: unknown[]) => deleteMock(...args),
      deleteMany: (...args: unknown[]) => deleteManyMock(...args),
      update: (...args: unknown[]) => updateMock(...args),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
  logAudit,
}));

import {
  cleanupExpiredFeedDeliveryClaims,
  deliverFeedItemOnce,
  feedDeliveryClaimHash,
} from '../../src/modules/feeds/feedDeliveryClaim';

function p2002(): Error & { code: string } {
  return Object.assign(new Error('unique'), { code: 'P2002' });
}

describe('polling feed delivery claims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createMock.mockResolvedValue({});
    deleteMock.mockResolvedValue({});
    deleteManyMock.mockResolvedValue({ count: 0 });
    updateMock.mockResolvedValue({});
  });

  test('claims before send and finalizes only after a successful Discord delivery', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const now = new Date('2026-09-12T10:00:00.000Z');

    await expect(deliverFeedItemOnce('feed-1', 'item-1', send, now)).resolves.toBe('DELIVERED');

    const hash = feedDeliveryClaimHash('feed-1', 'item-1');
    expect(hash).toMatch(/^feed-delivery:[a-f0-9]{64}$/);
    expect(createMock).toHaveBeenCalledWith({
      data: {
        hash,
        status: 'PROCESSING',
        expiresAt: new Date('2027-03-11T10:00:00.000Z'),
      },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { hash },
      data: {
        status: 'DONE',
        responseStatus: 200,
        responseBody: { kind: 'feed-delivery', feedId: 'feed-1', itemId: 'item-1' },
      },
    });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('treats an existing non-expired PROCESSING or DONE claim as already delivered/claimed', async () => {
    createMock.mockRejectedValueOnce(p2002());
    deleteManyMock.mockResolvedValueOnce({ count: 0 });
    const send = jest.fn();

    await expect(deliverFeedItemOnce('feed-1', 'item-1', send)).resolves.toBe('ALREADY_CLAIMED');

    expect(send).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('reclaims only the exact expired delivery claim and remains race-safe', async () => {
    createMock
      .mockRejectedValueOnce(p2002())
      .mockResolvedValueOnce({});
    deleteManyMock.mockResolvedValueOnce({ count: 1 });
    const send = jest.fn().mockResolvedValue(undefined);
    const now = new Date('2026-09-12T10:00:00.000Z');

    await expect(deliverFeedItemOnce('feed-2', 'item-9', send, now)).resolves.toBe('DELIVERED');

    const hash = feedDeliveryClaimHash('feed-2', 'item-9');
    expect(deleteManyMock).toHaveBeenCalledWith({ where: { hash, expiresAt: { lt: now } } });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('releases the claim after a definite Discord send failure so the item can retry', async () => {
    const failure = new Error('discord send failed');
    const send = jest.fn().mockRejectedValue(failure);

    await expect(deliverFeedItemOnce('feed-3', 'item-3', send)).rejects.toThrow('discord send failed');

    expect(deleteMock).toHaveBeenCalledWith({ where: { hash: feedDeliveryClaimHash('feed-3', 'item-3') } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  test('stays fail-closed when Discord succeeded but claim finalization fails', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    updateMock.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(deliverFeedItemOnce('feed-4', 'item-4', send)).resolves.toBe('DELIVERED');

    expect(send).toHaveBeenCalledTimes(1);
    expect(deleteMock).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith('FEED_DELIVERY_FINALIZE_FAILED', 'SECURITY', {
      feedId: 'feed-4',
      itemId: 'item-4',
    });
  });

  test('cleanup is limited to expired feed-delivery namespace rows', async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 3 });
    const now = new Date('2026-09-12T10:00:00.000Z');

    await expect(cleanupExpiredFeedDeliveryClaims(now, true)).resolves.toBe(3);

    expect(deleteManyMock).toHaveBeenCalledWith({
      where: {
        hash: { startsWith: 'feed-delivery:' },
        expiresAt: { lt: now },
      },
    });
    expect(loggerInfo).toHaveBeenCalledWith('Feed-Delivery-Claims bereinigt: 3');
  });
});
