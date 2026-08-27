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

  it('CAS-claims a stale unsent intent and preserves join/leave dates with the resolved visible name', async () => {
    const updatedAt = new Date('2026-08-24T10:00:00.000Z');
    const joinedAt = new Date('2026-01-10T08:00:00.000Z');
    const discordId = '222222222222222222';
    findMany.mockResolvedValue([{
      id: 'delivery-1', guildId: '111111111111111111', discordId,
      membershipKey: 'a'.repeat(64), cleanupRequestId: 'cleanup-1', channelId: '333333333333333333',
      messageId: null, discordName: 'Nick', guildName: 'Guild', customMessage: 'Bye', joinedAt,
      leaveOccurredAt: new Date('2026-08-24T09:55:00.000Z'), cleanupEnabled: true,
      cleanupSnapshot: { servers: [{ nitradoConnId: 'conn-1', serverAlias: 'Server', playerNames: ['Player'], state: 'PENDING' }] },
      state: 'FAILED', lastError: 'old', createdAt: updatedAt, updatedAt,
    }]);
    const send = jest.fn().mockResolvedValue({ id: 'message-1' });
    setDashboardClient({
      users: { fetch: jest.fn().mockResolvedValue({ username: 'ResolvedUser', globalName: 'Resolved Name' }) },
      channels: { fetch: jest.fn().mockResolvedValue({
        guildId: '111111111111111111', isTextBased: () => true, isDMBased: () => false, send,
      }) },
    } as unknown as Client);

    await expect(recoverPendingGoodbyeDeliveries(new Date('2026-08-24T10:02:00.000Z'))).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].allowedMentions).toEqual({ parse: [] });
    const embedJson = send.mock.calls[0][0].embeds[0].toJSON();
    expect(embedJson.fields?.[0]).toMatchObject({ name: '👤 Mitglied', inline: false });
    expect(embedJson.fields?.[0].value).toContain('**Discord:** @Resolved Name');
    expect(embedJson.fields?.[0].value).not.toContain(discordId);
    expect(embedJson.fields?.[0].value).toContain('**Beigetreten:** 10. Januar 2026');
    expect(embedJson.fields?.[0].value).toContain('**Ausgetreten:** 24. August 2026');
    expect(updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'delivery-1', messageId: null, state: 'FAILED', updatedAt }),
    }));
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ messageId: 'message-1', state: 'SENT' }),
    }));
  });

  it('falls back to a readable stored name and never exposes the raw ID when user resolution fails', async () => {
    const updatedAt = new Date('2026-08-24T10:00:00.000Z');
    const discordId = '244444444444444444';
    findMany.mockResolvedValue([{
      id: 'delivery-safe', guildId: '111111111111111111', discordId,
      membershipKey: 'b'.repeat(64), cleanupRequestId: null, channelId: '333333333333333333',
      messageId: null, discordName: 'ReadableNick', guildName: 'Guild', customMessage: `Bye ${discordId}`,
      joinedAt: null, leaveOccurredAt: new Date('2026-08-24T09:55:00.000Z'), cleanupEnabled: false,
      cleanupSnapshot: null, state: 'FAILED', lastError: 'old', createdAt: updatedAt, updatedAt,
    }]);
    const send = jest.fn().mockResolvedValue({ id: 'message-safe' });
    setDashboardClient({
      users: { fetch: jest.fn().mockRejectedValue(new Error('not found')) },
      channels: { fetch: jest.fn().mockResolvedValue({
        guildId: '111111111111111111', isTextBased: () => true, isDMBased: () => false, send,
      }) },
    } as unknown as Client);

    await expect(recoverPendingGoodbyeDeliveries(new Date('2026-08-24T10:02:00.000Z'))).resolves.toBe(1);
    const serialized = JSON.stringify(send.mock.calls[0][0].embeds[0].toJSON());
    expect(serialized).toContain('@ReadableNick');
    expect(serialized).not.toContain(discordId);
  });

  it('does not send when another worker wins the intent lease', async () => {
    findMany.mockResolvedValue([{
      id: 'delivery-2', guildId: '111111111111111111', channelId: '333333333333333333', messageId: null,
      discordId: '255555555555555555', discordName: 'Nick', customMessage: 'Bye', joinedAt: null, leaveOccurredAt: new Date(), cleanupEnabled: false,
      cleanupSnapshot: null, state: 'PENDING', updatedAt: new Date('2026-08-24T10:00:00.000Z'),
    }]);
    updateMany.mockResolvedValueOnce({ count: 0 });
    const fetch = jest.fn();
    setDashboardClient({ channels: { fetch }, users: { fetch: jest.fn() } } as unknown as Client);

    await expect(recoverPendingGoodbyeDeliveries(new Date('2026-08-24T10:02:00.000Z'))).resolves.toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
