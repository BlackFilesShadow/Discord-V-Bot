process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const createMock = jest.fn().mockResolvedValue({ id: 'feed-atomic' });

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { feed: { create: (...args: unknown[]) => createMock(...args) } },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import { createFeed } from '../../src/modules/feeds/feedManagerV2';

describe('createFeed initial persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createMock.mockResolvedValue({ id: 'feed-atomic' });
  });

  test('persists optional initial state in the same Prisma create call', async () => {
    const id = await createFeed(
      'Build Feed',
      'WEBHOOK',
      'Build Hook',
      '222222222222222222',
      300,
      '888888888888888888',
      '999999999999999999',
      undefined,
      {
        mentionRoles: ['333333333333333333'],
        webhookSecret: 'secret-value',
        credentialsEnc: 'encrypted-value',
      },
    );

    expect(id).toBe('feed-atomic');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Build Feed',
        feedType: 'WEBHOOK',
        url: 'Build Hook',
        channelId: '222222222222222222',
        guildId: '999999999999999999',
        interval: 300,
        createdBy: '888888888888888888',
        mentionRoles: ['333333333333333333'],
        webhookSecret: 'secret-value',
        credentialsEnc: 'encrypted-value',
      }),
    });
  });
});
