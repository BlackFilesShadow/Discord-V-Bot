process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const findMany = jest.fn();
const updateMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { goodbyeDelivery: { findMany, updateMany } },
}));

import type { Client } from 'discord.js';
import { setDashboardClient } from '../../src/dashboard/clientRegistry';
import { recoverPendingGoodbyeDeliveries } from '../../src/modules/welcome/goodbyeStatus';

describe('Goodbye delivery restart recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('CAS-claims a stale unsent intent and preserves join/leave dates in the recovered embed', async () => {
    const updatedAt = new Date('2026-08-24T10:00:00.000Z');
    const joinedAt = new Date('2026-01-10T08:00:00.000Z');
    findMany.mockResolvedValue([{
      id: 'delivery-1', guildId: '111111111111111111', discordId: '222222222222222222',
      membershipKey: 'a'.repeat(64), cleanupRequestId: 'cleanup-1', channelId: '333333333333333333',
      messageId: null, discordName: 'Nick', guildName: 'Guild', customMessage: 'Bye', joinedAt,
      leaveOccurredAt: new Date('2026-08-24T09:55:00.000Z'), cleanupEnabled: true,
      cleanupSnapshot: { servers: [{ nitradoConnId: 'conn-1', serverAlias: 'Server', playerNames: ['Player'], state: 'PENDING' }] },
      state: 'FAILED', lastError: 'old', createdAt: updatedAt, updatedAt,
    }]);
    const send = jest.fn().mockResolvedValue({ id: 'message-1' });
    setDashboardClient({
      channels: { fetch: jest.fn().mockResolvedValue({
        guildId: '111111111111111111', isTextBased: () => true, isDMBased: () => false, send,
      }) },
    } as unknown as Client);

    await expect(recoverPendingGoodbyeDeliveries(new Date('2026-08-24T10:02:00.000Z'))).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    const embedJson = send.mock.calls[0][0].embeds[0].toJSON();
    const names = embedJson.fields?.map((field: { name: string }) => field.name) ?? [];
    expect(names.indexOf('Eintrittsdatum')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Austrittsdatum')).toBeGreaterThan(names.indexOf('Eintrittsdatum'));
    expect(embedJson.fields?.find((field: { name: string }) => field.name === 'Discord-Name')?.value)
      .toBe('<@222222222222222222>');
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'delivery-1', messageId: null, state: 'FAILED', updatedAt }),
    }));
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageId: 'message-1', state: 'SENT' }),
    }));
  });

  it('does not send when another worker wins the intent lease', async () => {
    findMany.mockResolvedValue([{
      id: 'delivery-2', guildId: '111111111111111111', channelId: '333333333333333333', messageId: null,
      discordName: 'Nick', customMessage: 'Bye', joinedAt: null, leaveOccurredAt: new Date(), cleanupEnabled: false,
      cleanupSnapshot: null, state: 'PENDING', updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    }]);
    updateMany.mockResolvedValueOnce({ count: 0 });
    const fetch = jest.fn();
    setDashboardClient({ channels: { fetch } } as unknown as Client);

    await expect(recoverPendingGoodbyeDeliveries(new Date('2026-08-24T10:02:00.000Z'))).resolves.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
